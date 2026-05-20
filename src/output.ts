export type Format = "json" | "table";

interface QuoteOption {
  id: string;
  carrierName: string;
  source: string;
  rate: number;
  transitTime: number;
  serviceLevel: string;
  serviceCharges?: Array<{ description: string; amount: number }>;
}

interface WarpQuote {
  quote_id?: string;
  price?: { amount: number; currency_code: string };
  transit_time?: number;
  status?: string;
}

interface MarketQuote {
  id?: string;
  requestId?: string;
  options?: QuoteOption[];
}

interface CombinedQuoteResponse {
  warp?: WarpQuote;
  market?: MarketQuote;
}

interface QuoteResponse {
  id?: string;
  requestId?: string;
  options?: QuoteOption[];
  warp?: WarpQuote;
  market?: MarketQuote;
}

function isQuoteResponse(data: unknown): data is QuoteResponse {
  if (typeof data !== "object" || data === null) return false;
  return "warp" in data || "options" in data;
}

function formatQuoteOutput(data: QuoteResponse): void {
  const combined = data as CombinedQuoteResponse;
  const warpQ = combined.warp as WarpQuote | undefined;
  const marketOpts = (combined.market as MarketQuote | undefined)?.options ?? [];

  if (!warpQ?.quote_id && marketOpts.length === 0) {
    console.log("No rates available for this lane.");
    return;
  }

  const td = (ms: number) => `${Math.round(ms / 86400)}d`;
  const others = [...marketOpts].filter(o => o.source !== "WARP").sort((a, b) => a.rate - b.rate);
  const cheapest = others[0];
  const warpCoversLane = !!(warpQ?.price);

  // Show all carriers: Warp first (if available), then market options sorted by rate
  type Row = { label: string; transit: string; rate: string; id: string; tag: string };
  const rows: Row[] = [];

  if (warpCoversLane) {
    rows.push({
      label: "★ Warp Technology",
      transit: warpQ!.transit_time ? `${warpQ!.transit_time}d` : "-",
      rate: `$${warpQ!.price!.amount.toFixed(2)}`,
      id: warpQ!.quote_id ?? "",
      tag: "[WARP]",
    });
  }

  for (const opt of others) {
    const isCheap = opt.id === cheapest?.id && !warpCoversLane;
    rows.push({
      label: opt.carrierName.slice(0, 30),
      transit: td(opt.transitTime),
      rate: `$${opt.rate.toFixed(2)}`,
      id: opt.id,
      tag: isCheap ? "[cheapest]" : "",
    });
  }

  // Column widths
  const labelW = Math.max(...rows.map(r => r.label.length), 10);
  const transitW = 7;
  const rateW = Math.max(...rows.map(r => r.rate.length), 8);

  console.log("");
  console.log(`  \x1b[2m${"Carrier".padEnd(labelW)}  ${"Transit".padEnd(transitW)}  ${"Rate".padEnd(rateW)}  Quote/Option ID\x1b[0m`);
  console.log(`  \x1b[2m${"─".repeat(labelW + transitW + rateW + 30)}\x1b[0m`);

  for (const row of rows) {
    const isWarp = row.tag === "[WARP]";
    const isCheap = row.tag === "[cheapest]";
    const tagStr = isWarp ? ` \x1b[32m${row.tag}\x1b[0m` : isCheap ? ` \x1b[33m${row.tag}\x1b[0m` : "";
    const labelStr = isWarp ? `\x1b[32m${row.label.padEnd(labelW)}\x1b[0m` : row.label.padEnd(labelW);
    console.log(`  ${labelStr}  ${row.transit.padEnd(transitW)}  ${row.rate.padEnd(rateW)}  ${row.id}${tagStr}`);
  }

  // Book instructions
  const bookFlags = [
    `--pickup-company "Shipper Co"`,
    `--pickup-street "123 Main St"`,
    `--pickup-city "City"`,
    `--pickup-state "CA"`,
    `--pickup-zip "90037"`,
    `--pickup-contact "John Doe"`,
    `--pickup-phone "2135550123"`,
    `--pickup-email "john@co.com"`,
    `--delivery-company "Consignee Co"`,
    `--delivery-street "456 Park Ave"`,
    `--delivery-city "New York"`,
    `--delivery-state "NY"`,
    `--delivery-zip "10002"`,
    `--delivery-contact "Jane Smith"`,
    `--delivery-phone "2125550456"`,
    `--delivery-email "jane@co.com"`,
  ].join(" ");

  const bookId = warpCoversLane ? (warpQ?.quote_id ?? "") : (cheapest?.id ?? rows[0]?.id ?? "");
  console.log(`\n\x1b[2m  To book:\x1b[0m`);
  console.log(`  warp-agent book ${bookId} ${bookFlags}`);
  console.log(`\n\x1b[2m  Quotes expire in ~15 min\x1b[0m\n`);
}

export function output(data: unknown, format: Format): void {
  if (format === "table") {
    printTable(data);
  } else if (format === "json") {
    // Pretty-print quote responses for humans; raw JSON for everything else
    if (isQuoteResponse(data) && process.stdout.isTTY) {
      formatQuoteOutput(data as QuoteResponse);
    } else {
      process.stdout.write(JSON.stringify(data, null, 2) + "\n");
    }
  } else {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
  }
}

function printTable(data: unknown): void {
  if (data === null || data === undefined) return;

  // Arrays: columnar table
  if (Array.isArray(data)) {
    if (data.length === 0) {
      console.log("(empty)");
      return;
    }
    printArrayTable(data as Record<string, unknown>[]);
    return;
  }

  // Objects with a single array property (e.g. { lanes: [...] })
  if (typeof data === "object") {
    const obj = data as Record<string, unknown>;
    const keys = Object.keys(obj);
    const arrayKey = keys.find((k) => Array.isArray(obj[k]));
    if (arrayKey && keys.length <= 3) {
      // Print non-array fields first
      for (const k of keys) {
        if (k !== arrayKey) {
          console.log(`${k}: ${String(obj[k])}`);
        }
      }
      if (keys.length > 1) console.log("");
      printArrayTable(obj[arrayKey] as Record<string, unknown>[]);
      return;
    }

    // Flat key-value
    printKeyValue(obj);
    return;
  }

  console.log(String(data));
}

function printKeyValue(obj: Record<string, unknown>): void {
  const maxKey = Math.max(...Object.keys(obj).map((k) => k.length));
  for (const [k, v] of Object.entries(obj)) {
    const val =
      typeof v === "object" && v !== null ? JSON.stringify(v) : String(v ?? "");
    console.log(`${k.padEnd(maxKey)}  ${val}`);
  }
}

function printArrayTable(rows: Record<string, unknown>[]): void {
  if (rows.length === 0) return;

  // Collect all scalar columns
  const cols = new Set<string>();
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      const v = row[k];
      if (typeof v !== "object" || v === null) cols.add(k);
    }
  }
  const colArr = [...cols];

  // Compute column widths
  const widths = new Map<string, number>();
  for (const c of colArr) widths.set(c, c.length);
  for (const row of rows) {
    for (const c of colArr) {
      const val = String(row[c] ?? "");
      const w = widths.get(c)!;
      if (val.length > w) widths.set(c, val.length);
    }
  }

  // Header
  const header = colArr.map((c) => c.padEnd(widths.get(c)!)).join("  ");
  console.log(header);
  console.log(colArr.map((c) => "-".repeat(widths.get(c)!)).join("  "));

  // Rows
  for (const row of rows) {
    const line = colArr
      .map((c) => String(row[c] ?? "").padEnd(widths.get(c)!))
      .join("  ");
    console.log(line);
  }
}
