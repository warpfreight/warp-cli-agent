#!/usr/bin/env node
/**
 * End-to-end smoke test for @warpfreight/cli-agent.
 *
 * What it does:
 *   1. Exec each CLI command in a subprocess
 *   2. Assert exit code + parse JSON output where applicable
 *   3. Exits 0 on success, 1 on any failure
 *
 * What it does NOT do:
 *   - Book any freight. Booking is verified at schema-level via `warp-agent ltl
 *     quote --help`-style probes and a quote round-trip only.
 *
 * Required env:
 *   WARP_API_KEY  — a wak_test_* sandbox key. Or pre-existing ~/.warp/config.json.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, "..", "dist", "cli.js");
const NODE = process.execPath;

let failures = 0;
function expect(label, cond, detail) {
  const sym = cond ? "✓" : "✗";
  console.log(`  ${sym} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures += 1;
}

function run(args) {
  return spawnSync(NODE, [CLI, ...args], {
    encoding: "utf8",
    env: process.env,
    timeout: 15000,
  });
}

console.log("== help ==");
const help = run(["--help"]);
expect("help exits 0", help.status === 0);
expect("help mentions signup", help.stdout.includes("signup"));
expect("help mentions login", help.stdout.includes("login"));
expect("help mentions ltl", help.stdout.includes("ltl"));

console.log("\n== version ==");
const v = run(["--version"]);
expect("version exits 0", v.status === 0);
expect("version is semver", /^\d+\.\d+\.\d+/.test(v.stdout.trim()));

console.log("\n== whoami ==");
const who = run(["whoami"]);
expect(
  "whoami runs without crash (exit 0 or 1 depending on auth)",
  who.status === 0 || who.status === 1,
);

console.log("\n== status (API health) ==");
const st = run(["status"]);
expect("status exits 0", st.status === 0);
let stBody;
try {
  stBody = JSON.parse(st.stdout);
} catch {}
expect("status returns JSON", stBody != null);
if (stBody) {
  expect("status.api == v1", stBody.api === "v1");
  expect("status.commit is string", typeof stBody.commit === "string");
}

console.log("\n== ltl quote subcommand help ==");
const ltlHelp = run(["ltl", "quote", "--help"]);
expect("ltl quote --help exits 0", ltlHelp.status === 0);
expect("ltl quote --help mentions --pallets", ltlHelp.stdout.includes("--pallets"));
expect("ltl quote --help mentions --dims", ltlHelp.stdout.includes("--dims"));

console.log("\n== ftl quote (public endpoint, real round-trip) ==");
const fut = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
const ftl = run(["ftl", "quote", "90007", "90038", "--date", fut]);
expect("ftl quote exits 0", ftl.status === 0, `stderr: ${ftl.stderr?.slice(0, 200)}`);
let ftlBody;
try {
  ftlBody = JSON.parse(ftl.stdout);
} catch {}
expect("ftl quote returns JSON", ftlBody != null);
if (ftlBody?.warp) {
  expect("ftl quote returns warp.quote_id", typeof ftlBody.warp.quote_id === "string");
  expect("ftl quote returns warp.price.amount > 0", ftlBody.warp.price?.amount > 0);
}

console.log("\n== quote-history (auth required) ==");
const qh = run(["quote-history"]);
expect("quote-history exits 0", qh.status === 0);
let qhBody;
try {
  qhBody = JSON.parse(qh.stdout);
} catch {}
expect("quote-history returns JSON array", Array.isArray(qhBody));

console.log(failures === 0 ? "\n✅ all checks passed" : `\n❌ ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
