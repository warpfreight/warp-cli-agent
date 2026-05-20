/**
 * Warp account provisioning + login.
 *
 * Two flows:
 *   1. New account  — register → clear credit limit → generate API key
 *   2. Existing account — login (AES-encrypted creds) → fetch or generate API key
 *
 * The API key returned is the same one shown in customer.wearewarp.com/dashboard/developer.
 * All quotes and bookings made with it are tied to that customer's account.
 */

import { createCipheriv } from "node:crypto";

// ── Config ────────────────────────────────────────────────────────────────────

const CUSTOMER_URL = "https://customer.wearewarp.com";
const GW_URL       = "https://gw-cdn.wearewarp.com/api/v1";
const AUTH_URL     = "https://auth.wearewarp.com";

// These are the dev/production AES keys Warp uses to encrypt credentials.
// Same values as in the portal .env — production keys must be set via env var.
const AES_KEY = process.env.WARP_AUTH_AES_KEY || "y1pSrKRLLkCQGbt0rqA5DJh3XnjDG3j9";
const AES_IV  = process.env.WARP_AUTH_AES_IV  || "U0mkzdFK7naqEn60";

function appHeader(): string {
  const ts = new Date().toISOString().replace(/[-T:.Z]/g, "").slice(0, 14);
  return `4;0.1.362;${ts}`;
}

function baseHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    app: appHeader(),
    Origin: CUSTOMER_URL,
  };
}

function encryptCredentials(email: string, pw: string): string {
  const text = JSON.stringify({ email, pw });
  const cipher = createCipheriv(
    "aes-256-cbc",
    Buffer.from(AES_KEY, "utf8"),
    Buffer.from(AES_IV, "utf8"),
  );
  let enc = cipher.update(text, "utf8", "base64");
  enc += cipher.final("base64");
  return enc;
}

async function safeJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try { return JSON.parse(text) as Record<string, unknown>; } catch { return { message: text }; }
}

// ── Shared: fetch or generate API key ─────────────────────────────────────────

async function fetchOrCreateApiKey(accessToken: string): Promise<string | null> {
  const jwtHeaders = { ...baseHeaders(), Authorization: `Bearer ${accessToken}` };
  const apiKeyUrl  = `${CUSTOMER_URL}/api/developer/apikey`;

  // Try to fetch existing key first
  const getRes = await fetch(apiKeyUrl, { headers: jwtHeaders });
  if (getRes.ok) {
    const data = await safeJson(getRes) as Record<string, unknown>;
    if (data && data.value) return data.value as string;
  }

  // No key exists — generate one via the portal BFF
  const genRes = await fetch(apiKeyUrl, { method: "POST", headers: jwtHeaders });
  if (!genRes.ok) {
    const body = await genRes.text();
    throw new Error(`Failed to generate API key (${genRes.status}): ${body}. Please generate one manually at customer.wearewarp.com/dashboard/developer`);
  }

  // Wait briefly for key to propagate
  await new Promise(r => setTimeout(r, 1000));

  // Fetch the newly generated key
  const keyRes = await fetch(apiKeyUrl, { headers: jwtHeaders });
  if (!keyRes.ok) return null;

  const keyData = await safeJson(keyRes) as Record<string, unknown>;
  if (!keyData?.value) {
    throw new Error(`API key was generated but could not be retrieved. Go to customer.wearewarp.com/dashboard/developer, copy your API key, and run:\n  export WARP_API_KEY="<your-key>"`);
  }
  return (keyData?.value as string) ?? null;
}

// ── Existing account login ─────────────────────────────────────────────────────

export interface LoginInput {
  email: string;
  password: string;
}

export interface LoginResult {
  ok: boolean;
  apiKey: string | null;
  email: string;
  error: string | null;
}

export async function loginWarpAccount(input: LoginInput): Promise<LoginResult> {
  const encrypted = encryptCredentials(input.email, input.password);

  // 1. Login → get JWT
  const loginRes = await fetch(`${AUTH_URL}/v1/login`, {
    method: "POST",
    headers: baseHeaders(),
    body: JSON.stringify({ data: encrypted }),
  });

  if (!loginRes.ok) {
    const body = await safeJson(loginRes);
    const msg = (body.message as string) || `Login failed (${loginRes.status})`;
    return { ok: false, apiKey: null, email: input.email, error: msg };
  }

  const loginData = await safeJson(loginRes) as Record<string, unknown>;
  const inner = loginData.data as Record<string, unknown> ?? loginData;
  const accessToken = inner.accessToken as string;

  if (!accessToken) {
    return { ok: false, apiKey: null, email: input.email, error: "No access token in login response." };
  }

  // 2. Fetch or generate API key
  const apiKey = await fetchOrCreateApiKey(accessToken);
  if (!apiKey) {
    return { ok: false, apiKey: null, email: input.email, error: "Could not retrieve API key. Check your dashboard: customer.wearewarp.com" };
  }

  return { ok: true, apiKey, email: input.email, error: null };
}

// ── New account provisioning ──────────────────────────────────────────────────

export interface ProvisionInput {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  companyName: string;
  phone?: string;
}

export interface ProvisionResult {
  ok: boolean;
  apiKey: string | null;
  warpId: number | null;
  error: string | null;
}

export async function provisionWarpAccount(input: ProvisionInput): Promise<ProvisionResult> {
  // 1. Register
  const regRes = await fetch(`${CUSTOMER_URL}/api/auth/register`, {
    method: "POST",
    headers: baseHeaders(),
    body: JSON.stringify({
      companyName: input.companyName,
      firstName:   input.firstName,
      lastName:    input.lastName,
      email:       input.email,
      ...(input.phone ? { phone: input.phone } : {}),
      password:    input.password,
      confirmPassword: input.password,
    }),
  });

  if (!regRes.ok) {
    const body = await safeJson(regRes);
    const msg  = (body.message as string) || (body.error as string) || `Registration failed (${regRes.status})`;

    // If email already registered, offer to login instead
    if (regRes.status === 400 && msg.toLowerCase().includes("exist")) {
      return { ok: false, apiKey: null, warpId: null, error: `${msg} — use "warp-agent login --existing" to log in.` };
    }
    return { ok: false, apiKey: null, warpId: null, error: msg };
  }

  const regData = await safeJson(regRes) as Record<string, unknown>;
  const inner   = regData.data as Record<string, unknown> ?? regData;
  const accessToken  = inner.accessToken as string;
  const clientInfo   = inner.clientInfo as Record<string, unknown> ?? {};
  const warpId       = clientInfo.warpId as number ?? null;

  const jwtHeaders = { ...baseHeaders(), Authorization: `Bearer ${accessToken}` };

  // 2. Clear credit limit
  if (warpId) {
    await fetch(`${GW_URL}/clients/${warpId}`, {
      method: "PUT",
      headers: jwtHeaders,
      body: JSON.stringify({ isCreditLimitExceeded: false }),
    });
  }

  // 3. Fetch or generate API key
  const apiKey = await fetchOrCreateApiKey(accessToken);
  if (!apiKey) {
    return { ok: false, apiKey: null, warpId, error: "Failed to generate API key." };
  }

  return { ok: true, apiKey, warpId, error: null };
}
