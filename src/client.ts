/**
 * WarpClient — client against the Warp freight API via the warp-site proxy.
 *
 * Auth: `Authorization: Bearer <wak_*>` against /api/v1/warp/*. The proxy
 * accepts wak_live_* / wak_test_* tokens issued by `warp-agent signup`.
 * For the legacy direct gateway at gw.wearewarp.com, also send the
 * `apikey:` header as a fallback (so raw customer.wearewarp.com keys still
 * work when WARP_API_URL is overridden to point at gw directly).
 */

import type {
  QuoteResponse,
  BookResponse,
  BookPatch,
  AddressContact,
  VersionResponse,
  LanesResponse,
  ApiError,
} from "./types.js";

const DEFAULT_BASE_URL = "https://www.wearewarp.com/api/v1/warp";
const TIMEOUT_MS = 15_000;
const CLIENT_VERSION = "0.3.0";
const USER_AGENT = `warp-agent-cli/${CLIENT_VERSION}`;

export class WarpClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;

  constructor(apiKey?: string, baseUrl?: string) {
    this.apiKey = apiKey ?? process.env.WARP_API_KEY;
    this.baseUrl = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  // ── Quote endpoints (public — no apikey needed) ───────────────

  // Shared item builder
  private buildItems(pallets: number, weight: number, commodity?: string, dims?: { length: number; width: number; height: number }) {
    return [{
      name: commodity || "Freight",
      quantity: pallets,
      totalWeight: pallets * weight,
      weightUnit: "lbs",
      length: dims?.length ?? 48,
      width: dims?.width ?? 40,
      height: dims?.height ?? 48,
      sizeUnit: "IN",
      stackable: false,
    }];
  }

  // ── Self-serve API: quote via /api/v1/{mode}/quote (returns a wq_ id) and
  //    book via /api/v1/book (atomic Stripe charge + gw booking + do-not-invoice
  //    + accessorials + windows, all server-side). selfServeBase strips the
  //    /warp proxy segment off baseUrl (…/api/v1/warp → …/api/v1).
  private get selfServeBase(): string {
    return this.baseUrl.replace(/\/warp$/, "");
  }

  async selfServeQuote(mode: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = { ...params };
    // The quote route reads accessorials as body.accessorials {pickup, delivery},
    // not the flat pickup_services/delivery_services keys. Convert so accessorials
    // are priced into the quote — otherwise gw rejects the later booking with
    // "BookingData and quoteInfo must be the same pickupServices."
    const ps = params.pickup_services as string[] | undefined;
    const ds = params.delivery_services as string[] | undefined;
    if ((ps && ps.length) || (ds && ds.length)) {
      body.accessorials = { pickup: ps ?? [], delivery: ds ?? [] };
    }
    const res = await fetch(`${this.selfServeBase}/${mode}/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let json: unknown; try { json = JSON.parse(text); } catch { json = { error: text }; }
    if (!res.ok) throw new Error((json as { error?: string })?.error ?? `Quote failed (${res.status})`);
    return json as Record<string, unknown>;
  }

  async selfServeBook(body: Record<string, unknown>): Promise<BookResponse> {
    if (!this.apiKey) throw new Error("No API key. Run: warp-agent login");
    const res = await fetch(`${this.selfServeBase}/book`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let json: unknown; try { json = JSON.parse(text); } catch { json = { error: text }; }
    if (!res.ok) throw new Error((json as { error?: string })?.error ?? `Booking failed (${res.status})`);
    return json as unknown as BookResponse;
  }

  // Primary Warp quote — logs to quote history, returns PRICING_xxxx ID
  private async warpQuote(body: Record<string, unknown>): Promise<unknown> {
    return this.post("/freights/quote", body, true);
  }

  // Market quotes — all carriers, does NOT log to history
  private async marketQuote(body: Record<string, unknown>): Promise<unknown> {
    return this.post("/freights/freight-quote", body, true);
  }

  private async quoteCombined(warpBody: Record<string, unknown>, marketBody: Record<string, unknown>): Promise<QuoteResponse> {
    const [warpResult, marketResult] = await Promise.allSettled([
      this.warpQuote(warpBody),
      this.marketQuote(marketBody),
    ]);
    const warp = warpResult.status === "fulfilled" ? warpResult.value : null;
    const market = marketResult.status === "fulfilled" ? marketResult.value : null;
    if (!warp && !market) throw new Error("No rates available for this lane.");
    return { warp, market } as unknown as QuoteResponse;
  }

  async quoteVan(origin: string, dest: string, pallets: number, weight: number, date: string, pickupServices: string[] = [], deliveryServices: string[] = []): Promise<QuoteResponse> {
    const items = this.buildItems(pallets, weight);
    return this.quoteCombined(
      { pickupDate: date, pickupInfo: { zipcode: origin }, deliveryInfo: { zipcode: dest }, listItems: items },
      { pickupDate: date, pickupInfo: { zipcode: origin }, deliveryInfo: { zipcode: dest }, items, pickupServices, dropoffServices: deliveryServices },
    );
  }

  async quoteBoxTruck(origin: string, dest: string, pallets: number, weight: number, date: string, pickupServices: string[] = [], deliveryServices: string[] = []): Promise<QuoteResponse> {
    const items = this.buildItems(pallets, weight);
    return this.quoteCombined(
      { pickupDate: date, pickupInfo: { zipcode: origin }, deliveryInfo: { zipcode: dest }, listItems: items },
      { pickupDate: date, pickupInfo: { zipcode: origin }, deliveryInfo: { zipcode: dest }, items, pickupServices, dropoffServices: deliveryServices },
    );
  }

  async quoteFtl(origin: string, dest: string, date: string): Promise<QuoteResponse> {
    // FTL prices the whole truck, so pallets/weight don't move the rate — use
    // representative placeholders. Routes through the SAME working proxy path as
    // the other modes (warpQuote + marketQuote); the old public-search endpoint
    // (gw /p/customer-cli/freight-quote/search) was removed and 404s.
    const items = this.buildItems(1, 1000);
    const base = { pickupDate: date, pickupInfo: { zipcode: origin }, deliveryInfo: { zipcode: dest }, shipmentType: "FTL", vehicleType: { code: "DRY_VAN_53" } };
    return this.quoteCombined(
      { ...base, listItems: items },
      { ...base, items },
    );
  }

  async quoteLtl(
    origin: string, dest: string, pallets: number, weight: number,
    commodity: string | undefined,
    dims: { length: number; width: number; height: number },
    date: string,
    pickupServices: string[] = [],
    deliveryServices: string[] = [],
  ): Promise<QuoteResponse> {
    const listItems = this.buildItems(pallets, weight, commodity, dims);
    const items = listItems;
    const [warpResult, marketResult] = await Promise.allSettled([
      this.warpQuote({ pickupDate: date, pickupInfo: { zipcode: origin }, deliveryInfo: { zipcode: dest }, listItems }),
      this.marketQuote({ pickupDate: date, pickupInfo: { zipcode: origin }, deliveryInfo: { zipcode: dest }, items, shipmentType: "LTL", pickupServices, dropoffServices: deliveryServices }),
    ]);
    const warp = warpResult.status === "fulfilled" ? warpResult.value : null;
    const market = marketResult.status === "fulfilled" ? marketResult.value : null;
    if (!warp && !market) throw new Error("No rates available for this lane.");
    return { warp, market } as unknown as QuoteResponse;
  }

  // ── Booking (apikey required) ─────────────────────────────────

  private buildWindowTime(window?: string, date?: string): { from: string; to: string } {
    const w = window || "08:00-17:00";
    const [fromTime, toTime] = w.split("-");
    // Use tomorrow if no date context, or a generic future date
    const baseDate = date || new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    return {
      from: `${baseDate}T${fromTime}:00.000Z`,
      to: `${baseDate}T${toTime || "17:00"}:00.000Z`,
    };
  }

  async book(quoteId: string, patch?: BookPatch, reference?: string, promoCode?: string): Promise<BookResponse> {
    if (!patch?.pickup || !patch?.delivery) {
      throw new Error("Pickup and delivery address required. Use --pickup-street, --pickup-city, etc.");
    }
    const p = patch.pickup;
    const d = patch.delivery;
    const body: Record<string, unknown> = {
      quoteId,
      pickupInfo: {
        locationName: p.company || p.contactName,
        contactName: p.contactName,
        contactPhone: p.phone,
        contactEmail: p.email,
        address: { street: p.street, city: p.city, state: p.state, zipcode: p.zipCode, country: "US" },
        windowTime: this.buildWindowTime((p as AddressContact & { window?: string }).window),
      },
      deliveryInfo: {
        locationName: d.company || d.contactName,
        contactName: d.contactName,
        contactPhone: d.phone,
        contactEmail: d.email,
        address: { street: d.street, city: d.city, state: d.state, zipcode: d.zipCode, country: "US" },
        windowTime: this.buildWindowTime((d as AddressContact & { window?: string }).window),
      },
      listItems: patch.listItems ?? [{ name: "Freight", quantity: 1, totalWeight: 500, weightUnit: "lbs", length: 48, width: 40, height: 48, sizeUnit: "IN", stackable: false }],
    };
    if (reference) body.referenceNo = reference;
    if (patch.notes) body.note = patch.notes;
    if (promoCode) {
      // Validate promo code before booking
      try {
        const ts = new Date().toISOString().replace(/[-T:.Z]/g, "").slice(0, 14);
        const vRes = await fetch(
          `https://gw.wearewarp.com/v1/p/voucher/${encodeURIComponent(promoCode)}`,
          { headers: { app: `4;0.1.362;${ts}`, Origin: "https://customer.wearewarp.com" } }
        );
        if (vRes.ok) {
          const vd = await vRes.json() as { status?: string; voucher?: { code: string; amt: number } };
          if (vd.status === "valid" && vd.voucher) {
            body.voucher = { code: vd.voucher.code, amt: vd.voucher.amt };
          } else {
            throw new Error(`Promo code "${promoCode}" is ${vd.status ?? "invalid"}.`);
          }
        }
      } catch (e) {
        if ((e as Error).message.includes("invalid") || (e as Error).message.includes("expired")) throw e;
        // Network timeout — proceed without promo
      }
    }
    return this.post("/freights/booking", body, true);
  }

  // ── Shipments list (apikey required) ─────────────────────────

  async bookings(limit?: number): Promise<unknown> {
    const qs = limit ? `?pageSize=${limit}` : "";
    return this.get(`/freights/shipments${qs}`, true);
  }

  // ── Tracking (apikey required) ────────────────────────────────

  async track(shipmentId: string): Promise<unknown> {
    return this.post("/freights/tracking", { trackingNumbers: [shipmentId] }, true);
  }

  // ── Cancel (apikey required) ──────────────────────────────────

  async cancel(bookingId: string): Promise<unknown> {
    // Cancel uses the booking endpoint with a cancel flag
    return this.post("/freights/booking/cancel", { shipmentId: bookingId }, true);
  }

  // ── Events (apikey required) ──────────────────────────────────

  async events(shipmentId: string): Promise<unknown> {
    return this.get(`/freights/events/${encodeURIComponent(shipmentId)}`, true);
  }

  // ── Invoice (apikey required) ─────────────────────────────────

  async invoice(orderId: string): Promise<unknown> {
    return this.get(`/freights/invoices/${encodeURIComponent(orderId)}`, true);
  }

  // ── Documents (apikey required) ───────────────────────────────

  async documents(orderId: string, type?: string): Promise<unknown> {
    // ?type=bol returns external/brokered carrier BOLs too (Warp backend update 2026-05).
    const q = type ? `?type=${encodeURIComponent(type)}` : "";
    return this.get(`/freights/documents/${encodeURIComponent(orderId)}${q}`, true);
  }

  // ── Quote history (apikey required) ──────────────────────────

  async quoteHistory(): Promise<unknown> {
    // quote-log requires Bearer auth (not apikey header)
    if (!this.apiKey) throw new Error("No API key. Run: warp-agent login");
    const res = await fetch(`https://www.wearewarp.com/api/v1/freight/quote-log`, {
      headers: { "Authorization": `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
    });
    const data = await res.json() as { ok?: boolean; quotes?: unknown[] };
    return data?.quotes ?? data;
  }

  // ── Lane history (apikey required) ───────────────────────────

  async lanes(): Promise<LanesResponse> {
    // Derived from shipments — get unique lanes
    const data = await this.get<{ data: Array<{ pickupInfo?: { zipcode?: string }; deliveryInfo?: { zipcode?: string } }> }>("/freights/shipments?pageSize=100", true);
    const seen = new Set<string>();
    const lanes: Array<{ origin: string; dest: string }> = [];
    for (const s of data.data ?? []) {
      const origin = s.pickupInfo?.zipcode;
      const dest   = s.deliveryInfo?.zipcode;
      if (origin && dest) {
        const key = `${origin}-${dest}`;
        if (!seen.has(key)) { seen.add(key); lanes.push({ origin, dest }); }
      }
    }
    return { lanes } as unknown as LanesResponse;
  }

  // ── Status (public) ──────────────────────────────────────────

  async status(): Promise<VersionResponse> {
    // gw.wearewarp.com/version requires different auth — hit www instead
    const res = await fetch("https://www.wearewarp.com/api/v1/version", { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`Status check failed: ${res.status}`);
    return res.json() as Promise<VersionResponse>;
  }

  // ── Internal ─────────────────────────────────────────────────

  private headers(authed: boolean): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    };
    if (authed) {
      if (!this.apiKey) throw new Error("No API key. Run: warp-agent login");
      // Default path: warp-site proxy accepts wak_* via Bearer. For the
      // legacy gateway, also include `apikey:` so raw keys still work when
      // WARP_API_URL is overridden to point at gw.wearewarp.com directly.
      h["Authorization"] = `Bearer ${this.apiKey}`;
      if (this.baseUrl.includes("gw.wearewarp.com")) {
        h["apikey"] = this.apiKey;
      }
    }
    return h;
  }

  private async request(method: string, path: string, body: unknown, authed: boolean): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(authed),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const json = await res.json() as unknown;
      if (!res.ok) {
        const err = json as ApiError & { message?: string };
        const rawMsg = err?.error ?? err?.message ?? `HTTP ${res.status}`;
        // Translate internal Warp errors to human-readable messages
        const msg = rawMsg.includes('listItems')
          ? 'Quote expired or freight details mismatch. Please run a new quote and book immediately.'
          : rawMsg.toUpperCase().includes('PAYMENT_REQUIRED') || rawMsg.toLowerCase().includes('payment') || res.status === 402
          ? 'No payment method on file.\n\n  Add a card at: https://www.wearewarp.com/agents/onboard\n  Then retry your booking.'
          : rawMsg.toLowerCase().includes('credit') && rawMsg.toLowerCase().includes('limit')
          ? 'To complete your booking and get your tracking details, add a payment method to your Warp account:\n\n  https://www.wearewarp.com/agents/onboard\n\nThen retry your booking.'
          : rawMsg;
        throw new Error(msg);
      }
      return json;
    } catch (e: unknown) {
      if (e instanceof Error && e.name === "AbortError") throw new Error("Request timed out (15s).");
      throw e;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async get<T = unknown>(path: string, authed: boolean): Promise<T> {
    return this.request("GET", path, undefined, authed) as Promise<T>;
  }

  private async post<T = unknown>(path: string, body: unknown, authed = false): Promise<T> {
    return this.request("POST", path, body, authed) as Promise<T>;
  }
}
