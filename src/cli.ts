import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { readFileSync } from "node:fs";
import { WarpClient } from "./client.js";
import { output, type Format } from "./output.js";
import { loadConfig, saveConfig, clearConfig, configPath } from "./config.js";
import { provisionWarpAccount, loginWarpAccount } from "./provision.js";
import { trackBooking, trackEvent, getAnalytics, cacheQuoteAmount, getCachedQuoteAmount, cacheQuoteItems, getCachedQuoteItems } from "./analytics.js";
import { notifyQuote, notifyBooking } from "./slack.js";
import type { AddressContact, BookPatch } from "./types.js";

// ── ASCII banner ──────────────────────────────────────────────

const BANNER = `
\x1b[32m ██╗    ██╗ █████╗ ██████╗ ██████╗ \x1b[0m
\x1b[32m ██║    ██║██╔══██╗██╔══██╗██╔══██╗\x1b[0m
\x1b[32m ██║ █╗ ██║███████║██████╔╝██████╔╝\x1b[0m
\x1b[32m ██║███╗██║██╔══██║██╔══██╗██╔═══╝ \x1b[0m
\x1b[32m ╚███╔███╔╝██║  ██║██║  ██║██║     \x1b[0m
\x1b[32m  ╚══╝╚══╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     \x1b[0m
\x1b[2m Freight Agent CLI — www.wearewarp.com/tools/cli\x1b[0m
`;

// ── No startup animation — banner only ────────────────────────────────
// No animation — just pass through the task
export async function showPalletAnimation<T>(task?: Promise<T>): Promise<T | void> {
  if (task) return task;
}


// Loading spinner for login
export async function showLoginSpinner(label: string, task: Promise<unknown>): Promise<void> {
  if (!process.stdout.isTTY) { await task; return; }
  const frames = ['\u280b','\u2819','\u2839','\u2838','\u283c','\u2834','\u2826','\u2807','\u280f','\u2817'];
  const G = '\x1b[32m', R = '\x1b[0m';
  let i = 0;
  let done = false;
  const iv = setInterval(() => {
    if (done) return;
    process.stdout.write(`\r${G}${frames[i % frames.length]}${R}  ${label}  `);
    i++;
  }, 80);
  try { await task; } finally {
    done = true;
    clearInterval(iv);
    process.stdout.write(`\r\x1b[2K`);
  }
}

function validatePickupDate(date: string) {
  // Reject non-YYYY-MM-DD format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Invalid pickup date "${date}" — use YYYY-MM-DD format (e.g. ${new Date().toISOString().slice(0,10)})`);
  }
  // Reject impossible calendar dates (e.g. Feb 30, April 31)
  const [y, m, d] = date.split('-').map(Number);
  const parsed = new Date(y, m - 1, d);
  if (parsed.getFullYear() !== y || parsed.getMonth() !== m - 1 || parsed.getDate() !== d) {
    throw new Error(`Invalid pickup date "${date}" — ${m}/${d} does not exist on the calendar`);
  }
  // Reject dates in the past
  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (parsed < today) {
    throw new Error(`Pickup date "${date}" is in the past — use today or a future date`);
  }
  return true;
}

function validateShipmentInputs(pallets: number, weight: number): void {
  if (!Number.isInteger(pallets) || pallets < 1) {
    throw new Error(`Invalid pallet count "${pallets}" — must be a positive integer (1 or more)`);
  }
  if (pallets > 26) {
    throw new Error(`Pallet count "${pallets}" exceeds maximum — LTL supports up to 26 pallets (use FTL for larger shipments)`);
  }
  if (!Number.isFinite(weight) || weight <= 0) {
    throw new Error(`Invalid weight "${weight}" — must be a positive number in lbs`);
  }
  if (weight > 5000) {
    throw new Error(`Weight per pallet "${weight} lbs" exceeds maximum — max 5000 lbs per pallet`);
  }
}

function showBanner(): void {
  if (!process.stdout.isTTY) return;
  process.stdout.write(BANNER + "\n");
}

// ── Program ────────────────────────────────────────────────────

const program = new Command();

program
  .name("warp-agent")
  .description("CLI for the Warp freight API")
  .version(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version)
  .option("--key <key>", "API key (overrides saved config)")
  .option("--base-url <url>", "API base URL")
  .option("--format <fmt>", "Output format: json or table", "json")
  .hook("preAction", () => {
    // Banner + animation already shown at top level
  });

// ── Auth helpers ────────────────────────────────────────────

function resolveKey(): string | undefined {
  const opts = program.opts();
  // Priority: --key flag > WARP_API_KEY env > ~/.warp/config.json
  return opts.key ?? process.env.WARP_API_KEY ?? loadConfig()?.api_key;
}

function getClient(): WarpClient {
  const opts = program.opts();
  return new WarpClient(resolveKey(), opts.baseUrl ?? loadConfig()?.base_url);
}

function getAuthedClient(): WarpClient {
  const key = resolveKey();
  if (!key) {
    throw new Error(
      "No API key found. Run 'warp-agent login' to connect your Warp account, or 'warp-agent signup' to create a new one.",
    );
  }
  const opts = program.opts();
  return new WarpClient(key, opts.baseUrl ?? loadConfig()?.base_url);
}

function getFmt(): Format {
  const f = program.opts().format;
  return f === "table" ? "table" : "json";
}

async function run(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    output({ error: msg }, getFmt());
    process.exitCode = 1;
  }
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim();
}

async function promptPassword(question: string): Promise<string> {
  return new Promise((resolve) => {
    stdout.write(question);
    const raw = stdin.setRawMode?.(true);
    stdin.resume();
    let pwd = "";
    const onData = (ch: Buffer) => {
      const c = ch.toString();
      if (c === "\n" || c === "\r" || c === "\u0004") {
        stdin.removeListener("data", onData);
        if (raw) stdin.setRawMode(false);
        stdin.pause();
        stdout.write("\n");
        resolve(pwd);
      } else if (c === "\u007f" || c === "\b") {
        if (pwd.length > 0) {
          pwd = pwd.slice(0, -1);
          stdout.write("\b \b");
        }
      } else if (c === "\u0003") {
        process.exit(1);
      } else {
        pwd += c;
        stdout.write("*");
      }
    };
    stdin.on("data", onData);
  });
}

// ── Login flow ──────────────────────────────────────────────

// Check if the agent has a card on file via the /api/v1/agents/me endpoint.
// Returns true if card is on file, false if not, null if the check fails.
async function checkPaymentStatus(apiKey: string): Promise<boolean | null> {
  try {
    const res = await fetch("https://www.wearewarp.com/api/v1/agents/me", {
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { has_card?: boolean };
    return !!data.has_card;
  } catch {
    return null; // fail open — don't block login if check fails
  }
}

async function interactiveLogin(existingAccount: boolean): Promise<void> {
  const existing = loadConfig();
  if (existing && !existingAccount) {
    console.log(`Already logged in as ${existing.email}`);
    console.log(`Config: ${configPath()}`);
    console.log(`Run "warp-agent logout" to switch accounts.`);
    return;
  }

  const email = await prompt("Email: ");
  if (!email) throw new Error("Email is required.");

  const password = await promptPassword("Password: ");
  if (!password || password.length < 6) {
    throw new Error("Password must be at least 6 characters.");
  }

  if (existingAccount) {
    // ── Existing account login ──
    console.log("");
    let result: Awaited<ReturnType<typeof loginWarpAccount>>;
    await showLoginSpinner("Logging in to Warp...", loginWarpAccount({ email, password }).then(r => { result = r; }));
    result = result!;

    // If login failed because email doesn’t exist, offer to sign up
    if (!result.ok && result.error?.toLowerCase().includes("incorrect")) {
      console.log(`\nNo account found for ${email}.`);
      const signup = await prompt("Create a new account? (yes/no): ");
      if (signup.toLowerCase().startsWith("y")) {
        const company = await prompt("Company: ");
        if (!company) throw new Error("Company name is required.");
        const firstName = await prompt("First name: ");
        if (!firstName) throw new Error("First name is required.");
        const lastName = await prompt("Last name: ");
        if (!lastName) throw new Error("Last name is required.");
        const phone = await prompt("Phone (e.g. +13105550000): ");
        if (!phone) throw new Error("Phone is required.");
        console.log("");
        let prov: Awaited<ReturnType<typeof provisionWarpAccount>>;
        await showLoginSpinner("Creating your Warp account...", provisionWarpAccount({ email, password, firstName, lastName, companyName: company, phone }).then(r => { prov = r; }));
        prov = prov!;
        if (!prov.ok || !prov.apiKey) throw new Error(prov.error ?? "Account creation failed.");
        saveConfig({ api_key: prov.apiKey, email });
        console.log(`\nAccount created. Logged in as ${email}.`);
        console.log("");
        console.log("To book shipments, add a payment method first:");
        console.log("  https://www.wearewarp.com/agents/onboard");
        return;
      } else {
        throw new Error("Login cancelled.");
      }
    }

    if (!result.ok || !result.apiKey) {
      throw new Error(result.error ?? "Login failed.");
    }
    saveConfig({ api_key: result.apiKey, email });
    console.log(`Logged in as ${email}. API key saved to ${configPath()}`);
    console.log("");
    const hasCard = await checkPaymentStatus(result.apiKey);
    if (hasCard === false) {
      console.log("\x1b[33mNo payment method on file.\x1b[0m");
      console.log("Add a card before booking: https://www.wearewarp.com/agents/onboard");
    } else if (hasCard === true) {
      console.log("\x1b[32mPayment method on file. Ready to book.\x1b[0m");
    } else {
      console.log("To book shipments, make sure you have a payment method on file:");
      console.log("  https://www.wearewarp.com/agents/onboard");
    }
    console.log("");
    console.log("Ready. Try:");
    console.log("  warp-agent ltl quote 90001 60601 --pallets 2 --weight 600 --dims 48x40x48 --date 2026-04-25");
    return;
  }

  // ── New account creation ──
  const company = await prompt("Company: ");
  if (!company) throw new Error("Company name is required.");

  const firstName = await prompt("First name: ");
  if (!firstName) throw new Error("First name is required.");
  const lastName = await prompt("Last name: ");
  if (!lastName) throw new Error("Last name is required.");
  const phone = await prompt("Phone (e.g. +13105550000): ");
  if (!phone) throw new Error("Phone is required.");

  console.log("");
  let result: Awaited<ReturnType<typeof provisionWarpAccount>>;
  await showLoginSpinner("Creating your Warp account...", provisionWarpAccount({ email, password, firstName, lastName, companyName: company, phone }).then(r => { result = r; }));
  result = result!;

  if (!result.ok || !result.apiKey) {
    throw new Error(result.error ?? "Account provisioning failed.");
  }

  saveConfig({ api_key: result.apiKey, email });

  console.log(`Account created. Credentials saved to ${configPath()}`);
  console.log("");
  console.log("\x1b[33mNext step: add a payment method to book shipments.\x1b[0m");
  console.log("  https://www.wearewarp.com/agents/onboard");
  console.log("");
  console.log("Ready. Try:");
  console.log("  warp-agent ltl quote 90001 60601 --pallets 2 --weight 600 --dims 48x40x48 --date 2026-04-25");
}

// ── Commands ────────────────────────────────────────────────

program
  .command("login")
  .description("Log in to your existing Warp account (saves API key locally)")
  .option("--email <email>", "Email address (non-interactive)")
  .option("--password <password>", "Password (non-interactive)")
  .action((opts: { email?: string; password?: string }) => run(async () => {
    if (opts.email && opts.password) {
      const result = await loginWarpAccount({ email: opts.email, password: opts.password });
      if (!result.ok || !result.apiKey) throw new Error(result.error ?? "Login failed.");
      saveConfig({ api_key: result.apiKey, email: opts.email });
      console.log(`Logged in as ${opts.email}. API key saved to ${configPath()}`);
      const hasCard = await checkPaymentStatus(result.apiKey);
      if (hasCard === false) console.log("No payment method on file. Add a card at: https://www.wearewarp.com/agents/onboard");
      else if (hasCard === true) console.log("Payment method on file. Ready to book.");
    } else {
      await interactiveLogin(true);
    }
  }));

program
  .command("signup")
  .description("Create a new Warp account and save credentials")
  .option("--email <email>", "Email address (non-interactive)")
  .option("--password <password>", "Password (non-interactive)")
  .option("--company <company>", "Company name (non-interactive)")
  .option("--first-name <name>", "First name (non-interactive)")
  .option("--last-name <name>", "Last name (non-interactive)")
  .option("--phone <phone>", "Phone number e.g. +13105550000 (non-interactive)")
  .action((opts: { email?: string; password?: string; company?: string; firstName?: string; lastName?: string; phone?: string }) => run(async () => {
    if (opts.email && opts.password && opts.company && opts.firstName && opts.lastName && opts.phone) {
      const result = await provisionWarpAccount({ email: opts.email, password: opts.password, companyName: opts.company, firstName: opts.firstName, lastName: opts.lastName, phone: opts.phone });
      if (!result.ok || !result.apiKey) throw new Error(result.error ?? "Signup failed.");
      saveConfig({ api_key: result.apiKey, email: opts.email });
      console.log(`Account created. Logged in as ${opts.email}. API key saved to ${configPath()}`);
      console.log("No payment method on file. Add a card at: https://www.wearewarp.com/agents/onboard");
    } else {
      await interactiveLogin(false);
    }
  }));

program
  .command("logout")
  .description("Remove saved credentials")
  .action(() =>
    run(async () => {
      if (clearConfig()) {
        console.log("Logged out. Credentials removed.");
      } else {
        console.log("No saved credentials found.");
      }
    }),
  );

program
  .command("whoami")
  .description("Show current account info and payment status")
  .action(() =>
    run(async () => {
      const config = loadConfig();
      if (!config) {
        throw new Error("Not logged in. Run 'warp-agent login' to connect your account.");
      }
      const hasCard = await checkPaymentStatus(config.api_key);
      const paymentStatus = hasCard === true
        ? 'Card on file — ready to book'
        : hasCard === false
        ? 'No card on file — add one at https://www.wearewarp.com/agents/onboard'
        : 'Payment status unknown';
      output(
        {
          email: config.email,
          payment: paymentStatus,
          config_path: configPath(),
          base_url: config.base_url ?? "https://www.wearewarp.com/api/v1",
          dashboard: "https://customer.wearewarp.com",
        },
        getFmt(),
      );
    }),
  );

// ── Quote commands (public, no auth needed) ─────────────────

function addQuoteOpts(cmd: Command): Command {
  return cmd
    .requiredOption("--pallets <n>", "Number of pallets", parseInt)
    .requiredOption("--weight <n>", "Weight per pallet (lbs)", parseInt)
    .requiredOption("--date <date>", "Pickup date (YYYY-MM-DD)");
}

const van = program.command("van").description("Cargo van operations");
addQuoteOpts(
  van.command("quote <origin> <dest>").description("Get a cargo van quote"),
)
  .option("--pickup-services <services>", "Comma-separated pickup accessorials (e.g. liftgate-pickup,residential-pickup)")
  .option("--delivery-services <services>", "Comma-separated delivery accessorials (e.g. liftgate-delivery,inside-delivery)")
  .action(
  (origin: string, dest: string, opts: { pallets: number; weight: number; date: string; pickupServices?: string; deliveryServices?: string }) =>
    run(async () => {
      const start = Date.now();
      const pickupSvcs = opts.pickupServices ? opts.pickupServices.split(',').map(s => s.trim()) : [];
      const deliverySvcs = opts.deliveryServices ? opts.deliveryServices.split(',').map(s => s.trim()) : [];
      try {
        validatePickupDate(opts.date);
        validateShipmentInputs(opts.pallets, opts.weight);
        const data = await showPalletAnimation(getAuthedClient().quoteVan(origin, dest, opts.pallets, opts.weight, opts.date, pickupSvcs, deliverySvcs));
        trackEvent({ product: 'warp-agent', source: 'cli', event_type: 'quote', tool_name: 'van quote', success: true, origin_zip: origin, dest_zip: dest, mode: 'van', duration_ms: Date.now() - start });
        const _vanData = data as unknown as Record<string, unknown>;
        notifyQuote({ source: 'cli', mode: 'van', origin_zip: origin, dest_zip: dest, pallets: opts.pallets, price: _vanData?.warp_price as number | undefined, quote_id: _vanData?.warp_quote_id as string | undefined, duration_ms: Date.now() - start }).catch(() => {});
        output(data, getFmt());
      } catch (e) {
        trackEvent({ product: 'warp-agent', source: 'cli', event_type: 'error', tool_name: 'van quote', success: false, error_message: String(e), duration_ms: Date.now() - start });
        throw e;
      }
    }),
);

const boxTruck = program.command("box-truck").description("Box truck operations");
addQuoteOpts(
  boxTruck.command("quote <origin> <dest>").description("Get a box truck quote"),
)
  .option("--pickup-services <services>", "Comma-separated pickup accessorials (e.g. liftgate-pickup,residential-pickup)")
  .option("--delivery-services <services>", "Comma-separated delivery accessorials (e.g. liftgate-delivery,inside-delivery)")
  .action(
  (origin: string, dest: string, opts: { pallets: number; weight: number; date: string; pickupServices?: string; deliveryServices?: string }) =>
    run(async () => {
      const start = Date.now();
      const pickupSvcs = opts.pickupServices ? opts.pickupServices.split(',').map(s => s.trim()) : [];
      const deliverySvcs = opts.deliveryServices ? opts.deliveryServices.split(',').map(s => s.trim()) : [];
      try {
        validatePickupDate(opts.date);
        validateShipmentInputs(opts.pallets, opts.weight);
        const data = await showPalletAnimation(getAuthedClient().quoteBoxTruck(origin, dest, opts.pallets, opts.weight, opts.date, pickupSvcs, deliverySvcs));
        trackEvent({ product: 'warp-agent', source: 'cli', event_type: 'quote', tool_name: 'box-truck quote', success: true, origin_zip: origin, dest_zip: dest, mode: 'box_truck', duration_ms: Date.now() - start });
        const _btData = data as unknown as Record<string, unknown>;
        notifyQuote({ source: 'cli', mode: 'box_truck', origin_zip: origin, dest_zip: dest, pallets: opts.pallets, price: _btData?.warp_price as number | undefined, quote_id: _btData?.warp_quote_id as string | undefined, duration_ms: Date.now() - start }).catch(() => {});
        output(data, getFmt());
      } catch (e) {
        trackEvent({ product: 'warp-agent', source: 'cli', event_type: 'error', tool_name: 'box-truck quote', success: false, error_message: String(e), duration_ms: Date.now() - start });
        throw e;
      }
    }),
);

const ftl = program.command("ftl").description("Full truckload operations");
ftl
  .command("quote <origin> <dest>")
  .description("Get an FTL quote")
  .requiredOption("--date <date>", "Pickup date (YYYY-MM-DD)")
  .action(
    (origin: string, dest: string, opts: { date: string }) =>
      run(async () => {
        const start = Date.now();
        try {
          validatePickupDate(opts.date);
          const data = await showPalletAnimation(getAuthedClient().quoteFtl(origin, dest, opts.date));
          trackEvent({ product: 'warp-agent', source: 'cli', event_type: 'quote', tool_name: 'ftl quote', success: true, origin_zip: origin, dest_zip: dest, mode: 'ftl', duration_ms: Date.now() - start });
          notifyQuote({ source: 'cli', mode: 'ftl', origin_zip: origin, dest_zip: dest, duration_ms: Date.now() - start }).catch(() => {});
          output(data, getFmt());
        } catch (e) {
          trackEvent({ product: 'warp-agent', source: 'cli', event_type: 'error', tool_name: 'ftl quote', success: false, error_message: String(e), duration_ms: Date.now() - start });
          throw e;
        }
      }),
  );

const ltl = program.command("ltl").description("LTL operations");
ltl
  .command("quote <origin> <dest>")
  .description("Get an LTL quote")
  .requiredOption("--pallets <n>", "Number of pallets", parseInt)
  .requiredOption("--weight <n>", "Weight per pallet (lbs)", parseInt)
  .option("--commodity <desc>", "Commodity description")
  .option("--pickup-services <services>", "Comma-separated pickup accessorials (e.g. liftgate-pickup,residential-pickup)")
  .option("--delivery-services <services>", "Comma-separated delivery accessorials (e.g. liftgate-delivery,inside-delivery)")
  .requiredOption("--dims <LxWxH>", "Dimensions in inches (e.g. 48x40x48)")
  .requiredOption("--date <date>", "Pickup date (YYYY-MM-DD)")
  .action(
    (
      origin: string,
      dest: string,
      opts: {
        pallets: number;
        weight: number;
        commodity?: string;
        pickupServices?: string;
        deliveryServices?: string;
        dims: string;
        date: string;
      },
    ) =>
      run(async () => {
        validatePickupDate(opts.date);
        validateShipmentInputs(opts.pallets, opts.weight);
        const dimParts = opts.dims.split("x").map(Number);
        if (dimParts.length !== 3 || dimParts.some(isNaN)) {
          throw new Error("--dims must be LxWxH (e.g. 48x40x48)");
        }
        const [length, width, height] = dimParts;
        const pickupSvcs = opts.pickupServices ? opts.pickupServices.split(',').map(s => s.trim()) : [];
        const deliverySvcs = opts.deliveryServices ? opts.deliveryServices.split(',').map(s => s.trim()) : [];
        const start = Date.now();
        try {
          const data = await showPalletAnimation(getAuthedClient().quoteLtl(
            origin,
            dest,
            opts.pallets,
            opts.weight,
            opts.commodity,
            { length, width, height },
            opts.date,
            pickupSvcs,
            deliverySvcs,
          ));
          // Cache quote amount for revenue tracking at booking
          const ltlData = data as unknown as Record<string, unknown>;
          const ltlQid = (ltlData?.warp as Record<string,unknown>)?.quote_id as string | undefined;
          const ltlAmt = ((ltlData?.warp as Record<string,unknown>)?.price as Record<string,unknown>)?.amount as number | undefined;
          if (ltlQid && ltlAmt) {
            cacheQuoteAmount(ltlQid, ltlAmt);
            // Log to our DB for quote history
            const key = resolveKey();
            if (key) {
              fetch('https://www.wearewarp.com/api/v1/freight/quote-log', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
                body: JSON.stringify({ quoteId: ltlQid, originZip: origin, destZip: dest, mode: 'LTL', priceCents: Math.round(ltlAmt * 100), pallets: opts.pallets }),
              }).catch(() => {});
            }
          }
          // Cache listItems so book command doesn't need --pallets/--weight/--dims
          if (ltlQid) {
            const pallets = opts.pallets ?? 1;
            const weightPerPallet = opts.weight ?? 500;
            const [l, w, h] = [length ?? 48, width ?? 40, height ?? 48];
            cacheQuoteItems(ltlQid, [{ name: opts.commodity || 'Freight', quantity: pallets, totalWeight: pallets * weightPerPallet, weightUnit: 'lbs', length: l, width: w, height: h, sizeUnit: 'IN', stackable: false }]);
          }
          trackEvent({ product: 'warp-agent', source: 'cli', event_type: 'quote', tool_name: 'ltl quote', success: true, origin_zip: origin, dest_zip: dest, mode: 'ltl', amount_usd: ltlAmt, quote_id: ltlQid, duration_ms: Date.now() - start });
          notifyQuote({ source: 'cli', mode: 'ltl', origin_zip: origin, dest_zip: dest, pallets: opts.pallets, price: ltlAmt, quote_id: ltlQid, duration_ms: Date.now() - start }).catch(() => {});
          output(data, getFmt());
        } catch (e) {
          trackEvent({ product: 'warp-agent', source: 'cli', event_type: 'error', tool_name: 'ltl quote', success: false, error_message: String(e), duration_ms: Date.now() - start });
          throw e;
        }
      }),
  );

// ── Booking commands (authed) ───────────────────────────────

program
  .command("book <quote_id>")
  .description("Book a quoted shipment")
  .option("--pickup-street <street>", "Pickup street address")
  .option("--pickup-city <city>", "Pickup city")
  .option("--pickup-state <state>", "Pickup state (2-letter)")
  .option("--pickup-zip <zip>", "Pickup ZIP code")
  .option("--pickup-company <company>", "Pickup company name")
  .option("--pickup-contact <name>", "Pickup contact name")
  .option("--pickup-phone <phone>", "Pickup phone number")
  .option("--pickup-email <email>", "Pickup email address")
  .option("--pickup-window <HH:MM-HH:MM>", "Pickup time window, e.g. 08:00-17:00 (default: 08:00-17:00)")
  .option("--delivery-street <street>", "Delivery street address")
  .option("--delivery-city <city>", "Delivery city")
  .option("--delivery-state <state>", "Delivery state (2-letter)")
  .option("--delivery-zip <zip>", "Delivery ZIP code")
  .option("--delivery-company <company>", "Delivery company name")
  .option("--delivery-contact <name>", "Delivery contact name")
  .option("--delivery-phone <phone>", "Delivery phone number")
  .option("--delivery-email <email>", "Delivery email address")
  .option("--delivery-window <HH:MM-HH:MM>", "Delivery time window, e.g. 08:00-17:00 (default: 08:00-17:00)")
  .option("--pallets <n>", "Number of pallets (must match quote)", parseInt)
  .option("--weight <lbs>", "Weight per pallet in lbs (must match quote)", parseFloat)
  .option("--dims <LxWxH>", "Pallet dimensions in inches, e.g. 48x40x48 (must match quote)")
  .option("--commodity <desc>", "Commodity description (must match quote)")
  .option("--reference <ref>", "PO or reference number")
  .option("--promo <code>", "Promo/discount code")
  .option("--notes <notes>", "Special instructions")
  .action(
    (
      quoteId: string,
      opts: {
        pickupStreet?: string;
        pickupCity?: string;
        pickupState?: string;
        pickupZip?: string;
        pickupCompany?: string;
        pickupContact?: string;
        pickupPhone?: string;
        pickupEmail?: string;
        pickupWindow?: string;
        deliveryStreet?: string;
        deliveryCity?: string;
        deliveryState?: string;
        deliveryZip?: string;
        deliveryCompany?: string;
        deliveryContact?: string;
        deliveryPhone?: string;
        deliveryEmail?: string;
        deliveryWindow?: string;
        reference?: string;
        promo?: string;
        notes?: string;
        pallets?: number;
        weight?: number;
        dims?: string;
        commodity?: string;
      },
    ) =>
      run(async () => {
        const patch: BookPatch = {};

        // Build listItems from quote params if provided (must match original quote)
        if (opts.pallets || opts.weight || opts.dims) {
          const pallets = opts.pallets ?? 1;
          const weightPerPallet = opts.weight ?? 500;
          const [l, w, h] = (opts.dims ?? '48x40x48').split('x').map(Number);
          patch.listItems = [{
            name: opts.commodity ?? 'Freight',
            quantity: pallets,
            totalWeight: pallets * weightPerPallet,
            weightUnit: 'lbs',
            length: l ?? 48,
            width: w ?? 40,
            height: h ?? 48,
            sizeUnit: 'IN',
            stackable: false,
          }];
        }

        const hasPickup = opts.pickupStreet || opts.pickupCity || opts.pickupState || opts.pickupZip || opts.pickupContact || opts.pickupPhone || opts.pickupEmail;
        if (hasPickup) {
          const missing = [];
          if (!opts.pickupStreet) missing.push("--pickup-street");
          if (!opts.pickupCity) missing.push("--pickup-city");
          if (!opts.pickupState) missing.push("--pickup-state");
          if (!opts.pickupZip) missing.push("--pickup-zip");
          if (!opts.pickupContact) missing.push("--pickup-contact");
          if (!opts.pickupPhone) missing.push("--pickup-phone");
          if (!opts.pickupEmail) missing.push("--pickup-email");
          if (missing.length) {
            throw new Error(`Incomplete pickup address. Missing: ${missing.join(", ")}`);
          }
          patch.pickup = {
            street: opts.pickupStreet!,
            city: opts.pickupCity!,
            state: opts.pickupState!,
            zipCode: opts.pickupZip!,
            company: opts.pickupCompany,
            contactName: opts.pickupContact!,
            phone: opts.pickupPhone!,
            email: opts.pickupEmail!,
            window: opts.pickupWindow,
          } satisfies AddressContact;
        }

        const hasDelivery = opts.deliveryStreet || opts.deliveryCity || opts.deliveryState || opts.deliveryZip || opts.deliveryContact || opts.deliveryPhone || opts.deliveryEmail;
        if (hasDelivery) {
          const missing = [];
          if (!opts.deliveryStreet) missing.push("--delivery-street");
          if (!opts.deliveryCity) missing.push("--delivery-city");
          if (!opts.deliveryState) missing.push("--delivery-state");
          if (!opts.deliveryZip) missing.push("--delivery-zip");
          if (!opts.deliveryContact) missing.push("--delivery-contact");
          if (!opts.deliveryPhone) missing.push("--delivery-phone");
          if (!opts.deliveryEmail) missing.push("--delivery-email");
          if (missing.length) {
            throw new Error(`Incomplete delivery address. Missing: ${missing.join(", ")}`);
          }
          patch.delivery = {
            street: opts.deliveryStreet!,
            city: opts.deliveryCity!,
            state: opts.deliveryState!,
            zipCode: opts.deliveryZip!,
            company: opts.deliveryCompany,
            contactName: opts.deliveryContact!,
            phone: opts.deliveryPhone!,
            email: opts.deliveryEmail!,
            window: opts.deliveryWindow,
          } satisfies AddressContact;
        }

        if (opts.notes) patch.notes = opts.notes;

        // Auto-load listItems from quote cache if not explicitly provided
        if (!patch.listItems) {
          const cached = getCachedQuoteItems(quoteId);
          if (cached) patch.listItems = cached;
        }

        const hasPatch = patch.pickup || patch.delivery || patch.notes || patch.listItems;

        // ── Charge card via wearewarp.com before booking ────────────────
        const config = loadConfig();
        if (config?.api_key) {
          // Get amount from cache — if missing, re-quote to get fresh price
          let amountForCharge = getCachedQuoteAmount(quoteId);
          if (!amountForCharge || amountForCharge <= 0) {
            // Cache miss — fetch price from Warp API directly
            try {
              const quoteRes = await fetch(`https://gw.wearewarp.com/api/v1/freights/quote-history`, {
                headers: { 'apikey': config.api_key },
                signal: AbortSignal.timeout(10000),
              });
              if (quoteRes.ok) {
                const history = await quoteRes.json() as { quotes?: Array<{ quote_id?: string; price?: { amount?: number } }> };
                const match = history.quotes?.find((q) => q.quote_id === quoteId);
                if (match?.price?.amount) amountForCharge = match.price.amount;
              }
            } catch { /* ignore — will fail at charge step */ }
          }
          if (!amountForCharge || amountForCharge <= 0) {
            throw new Error('Could not determine quote price. Please run a fresh quote and book immediately.');
          }
          const amountCents = Math.round(amountForCharge * 100);
          try {
            const chargeRes = await fetch('https://www.wearewarp.com/api/v1/agents/charge-me', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.api_key}` },
              body: JSON.stringify({ amount_cents: amountCents, quote_id: quoteId }),
              signal: AbortSignal.timeout(15000),
            });
            if (!chargeRes.ok) {
              const chargeBody = await chargeRes.json().catch(() => ({})) as { error?: string; code?: string; requires_action?: boolean };
              if (chargeBody.code === 'PAYMENT_REQUIRED') {
                throw new Error(`No payment method on file.\n\n  Add a card at: https://www.wearewarp.com/agents/onboard\n  Then retry your booking.`);
              }
              if (chargeBody.requires_action) {
                throw new Error(`Your card requires additional authentication. Please visit your Warp account to complete payment.`);
              }
              throw new Error(`Payment failed: ${chargeBody.error ?? chargeRes.status}`);
            }
          } catch (chargeErr: unknown) {
            if (chargeErr instanceof Error) throw chargeErr;
            throw new Error('Could not reach payment service. Check your connection and retry.');
          }
        }
        // ─────────────────────────────────────────────────────────────────

        let data: Record<string, unknown>;
        await showLoginSpinner("Booking shipment...", getAuthedClient().book(
          quoteId,
          hasPatch ? patch : undefined,
          opts.reference,
          opts.promo,
        ).then(r => { data = r as unknown as Record<string, unknown>; }));
        data = data!;

        const bookData = data as unknown as Record<string, unknown>;
        // Do-not-invoice is handled server-side by warp-site during book —
        // the proxy already sees the Stripe charge up-front and auto-marks
        // the order. No client-side secret needed; do not re-add.

        // Track analytics
        if (bookData?.trackingNumber) {
          const cachedAmt = getCachedQuoteAmount(quoteId);
          trackBooking({
            source: "cli",
            tracking_number: bookData.trackingNumber as string,
            order_id: bookData.orderId as string | undefined,
            shipment_id: bookData.shipmentId as string | undefined,
            quote_id: quoteId,
            amount_usd: cachedAmt,
            origin_zip: patch.pickup?.zipCode,
            dest_zip: patch.delivery?.zipCode,
          });
          notifyBooking({ source: 'cli', origin_zip: patch.pickup?.zipCode, dest_zip: patch.delivery?.zipCode, tracking_number: bookData.trackingNumber as string, order_id: bookData.orderId as string | undefined, shipment_id: bookData.shipmentId as string | undefined, quote_id: quoteId, amount_usd: cachedAmt ?? undefined }).catch(() => {});
        }
        const result = {
          ...bookData,
          tracking_dashboard: "https://customer.wearewarp.com",
        };
        output(result, getFmt());
      }),
  );

program
  .command("track <booking_id>")
  .description("Track a booked shipment")
  .action((bookingId: string) =>
    run(async () => {
      const data = await getAuthedClient().track(bookingId);
      output(data, getFmt());
    }),
  );

program
  
// ── Account commands (authed) ───────────────────────────────

program
  .command("lanes")
  .description("List your active lanes")
  .action(() =>
    run(async () => {
      const data = await getAuthedClient().lanes();
      output(data, getFmt());
    }),
  );

program
  .command("bookings")
  .description("List recent bookings")
  .option("--limit <n>", "Max results", parseInt)
  .action((opts: { limit?: number }) =>
    run(async () => {
      const data = await getAuthedClient().bookings(opts.limit);
      output(data, getFmt());
    }),
  );

// ── Shipment lifecycle (auth) ──────────────────────────────

program
  .command("events <shipment_id>")
  .description("Get the full tracking event history for a shipment")
  .action((shipmentId: string) =>
    run(async () => {
      const data = await getAuthedClient().events(shipmentId);
      output(data, getFmt());
    }),
  );

program
  .command("invoice <order_id>")
  .description("Retrieve the invoice for a shipment")
  .action((orderId: string) =>
    run(async () => {
      const data = await getAuthedClient().invoice(orderId);
      output(data, getFmt());
    }),
  );

program
  .command("documents <order_id>")
  .description("List shipment documents. Use --type bol for the Bill of Lading (incl. external/market-carrier BOLs).")
  .option("--type <type>", "Filter to one document type, e.g. 'bol' or 'pod'")
  .action((orderId: string, opts: { type?: string }) =>
    run(async () => {
      const data = await getAuthedClient().documents(orderId, opts.type);
      output(data, getFmt());
    }),
  );

program
  .command("quote-history")
  .description("List your past quote requests")
  .action(() =>
    run(async () => {
      const data = await getAuthedClient().quoteHistory();
      output(data, getFmt());
    }),
  );

// ── Multi-stop FTL ──────────────────────────────────────────

// ── Analytics ──────────────────────────────────────────────

program
  .command("analytics")
  .description("(removed) Usage analytics are no longer collected")
  .action(() =>
    run(async () => {
      console.log(`\n\x1b[1mWarp Tool Analytics\x1b[0m`);
      console.log(`\x1b[2m  Usage analytics collection has been removed. Use your bookings list\x1b[0m`);
      console.log(`\x1b[2m  (warp-agent bookings) and the Warp portal for shipment + revenue data.\x1b[0m`);
      console.log("");
    }),
  );

// ── Status (public) ─────────────────────────────────────────

program
  .command("status")
  .description("Check API health")
  .action(() =>
    run(async () => {
      const data = await getClient().status();
      output(data, getFmt());
    }),
  );

// ── Show banner + animation on any interactive invocation ──────────
// Runs before parse() so it appears on --help, login, signup, and bare

// Only show banner on login, signup, or bare invocation (no subcommand)
const _firstArg = process.argv[2];
if (process.stdout.isTTY && (!_firstArg || _firstArg === 'login' || _firstArg === 'signup' || _firstArg === '--help' || _firstArg === 'help')) {
  showBanner();
}
// Animation is triggered inside each quote command action, not here

// ── Default: show help when no command given ────────────────────────

if (process.argv.length === 2) {
  // banner already shown above
  const config = loadConfig();
  if (config) {
    console.log(`\x1b[32m✔\x1b[0m  Logged in as \x1b[1m${config.email}\x1b[0m`);
  } else {
    console.log(`\x1b[33m⚠\x1b[0m  Not logged in. Run \x1b[1mwarp-agent login\x1b[0m to get started.`);
  }
  console.log(`
\x1b[1mQuoting\x1b[0m
  warp-agent ltl quote <origin> <dest> --pallets 2 --weight 600 --dims 48x40x48 --date 2026-04-25
  warp-agent van quote <origin> <dest> --pallets 1 --weight 400 --date 2026-04-25
  warp-agent ftl quote <origin> <dest> --date 2026-04-25

\x1b[1mBooking & tracking\x1b[0m
  warp-agent book <quote_id> --pickup-street ... --delivery-street ...
  warp-agent track <shipment_id>
  warp-agent bookings

\x1b[1mShipment details\x1b[0m
  warp-agent events <shipment_id>
  warp-agent invoice <order_id>
  warp-agent documents <order_id>

\x1b[1mAccount\x1b[0m
  warp-agent login       Log in to existing Warp account
  warp-agent signup      Create a new Warp account
  warp-agent whoami      Show current account
  warp-agent logout      Remove saved credentials

\x1b[2mDocs: www.wearewarp.com/tools/cli  •  Dashboard: customer.wearewarp.com\x1b[0m
`);
  process.exit(0);
}

program.parse();
