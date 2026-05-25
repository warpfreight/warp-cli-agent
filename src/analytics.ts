// Analytics REMOVED. The previous implementation embedded a Supabase
// service_role key (full DB access, bypasses RLS) in this published package —
// a critical leak in a public npm package. Warp relies on Slack for
// visibility and does not use this sink, so trackEvent/trackBooking are now
// credential-free no-ops. The quote-amount cache further down is unrelated to
// analytics and is retained (the `book` command depends on it).

interface ToolEvent {
  product: string;
  source: 'mcp' | 'cli' | 'unknown';
  event_type: 'quote' | 'book' | 'track' | 'cancel' | 'list' | 'events' | 'invoice' | 'documents' | 'error' | 'other';
  tool_name?: string;
  success: boolean;
  error_message?: string;
  amount_usd?: number;
  origin_zip?: string;
  dest_zip?: string;
  carrier?: string;
  mode?: string;
  tracking_number?: string;
  order_id?: string;
  quote_id?: string;
  duration_ms?: number;
  customer_id?: string;
  customer_name?: string;
  metadata?: Record<string, unknown>;
}

export async function trackEvent(_event: ToolEvent): Promise<void> {
  /* analytics removed — credential-free no-op (see file header) */
}

// Legacy compat - keep trackBooking working
export function trackBooking(record: {
  source: string;
  tracking_number: string;
  order_id?: string;
  shipment_id?: string;
  quote_id?: string;
  amount_usd?: number;
  origin_zip?: string;
  dest_zip?: string;
  carrier?: string;
}): void {
  trackEvent({
    product: 'warp-agent',
    source: record.source as 'mcp' | 'cli',
    event_type: 'book',
    success: true,
    tracking_number: record.tracking_number,
    order_id: record.order_id,
    quote_id: record.quote_id,
    amount_usd: record.amount_usd,
    origin_zip: record.origin_zip,
    dest_zip: record.dest_zip,
    carrier: record.carrier,
    customer_id: getCustomerEmail(),
    customer_name: getCustomerEmail(),
  });
}

export function getCustomerEmail(): string | undefined {
  try {
    const { readFileSync: rfs } = require("node:fs");
    const { join: j } = require("node:path");
    const { homedir: hd } = require("node:os");
    const config = JSON.parse(rfs(j(hd(), ".warp", "config.json"), "utf8"));
    return config.email;
  } catch { return undefined; }
}

export function getAnalytics() { return {}; } // local analytics deprecated

// Quote amount cache for revenue tracking
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const QUOTE_CACHE = join(homedir(), ".warp", "quote_cache.json");

interface QuoteCacheEntry {
  amount?: number;
  listItems?: unknown[];
  context?: Record<string, unknown>;
}

function readQuoteCache(): Record<string, QuoteCacheEntry> {
  try { return JSON.parse(readFileSync(QUOTE_CACHE, "utf8")); } catch { return {}; }
}

function writeQuoteCache(cache: Record<string, QuoteCacheEntry>): void {
  try {
    const dir = join(homedir(), ".warp");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const keys = Object.keys(cache);
    if (keys.length > 100) delete cache[keys[0]];
    writeFileSync(QUOTE_CACHE, JSON.stringify(cache));
  } catch {}
}

export function cacheQuoteAmount(quoteId: string, amount: number): void {
  try {
    const cache = readQuoteCache();
    cache[quoteId] = { ...cache[quoteId], amount };
    writeQuoteCache(cache);
  } catch {}
}

export function cacheQuoteItems(quoteId: string, listItems: unknown[]): void {
  try {
    const cache = readQuoteCache();
    cache[quoteId] = { ...cache[quoteId], listItems };
    writeQuoteCache(cache);
  } catch {}
}

export function getCachedQuoteAmount(quoteId: string): number | undefined {
  try { return readQuoteCache()[quoteId]?.amount; } catch { return undefined; }
}

export function getCachedQuoteItems(quoteId: string): unknown[] | undefined {
  try { return readQuoteCache()[quoteId]?.listItems; } catch { return undefined; }
}

// Full re-quote context, so `book` can re-quote via the self-serve
// /api/v1/{mode}/quote endpoint (to get a wq_ id that /api/v1/book accepts —
// which is what applies do-not-invoice + accessorials + windows server-side).
export function cacheQuoteContext(quoteId: string, context: Record<string, unknown>): void {
  try {
    const cache = readQuoteCache();
    cache[quoteId] = { ...cache[quoteId], context };
    writeQuoteCache(cache);
  } catch {}
}

export function getCachedQuoteContext(quoteId: string): Record<string, unknown> | undefined {
  try { return readQuoteCache()[quoteId]?.context as Record<string, unknown> | undefined; } catch { return undefined; }
}
