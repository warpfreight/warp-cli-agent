# @warpfreight/cli-agent

[![npm version](https://img.shields.io/npm/v/@warpfreight/cli-agent.svg)](https://www.npmjs.com/package/@warpfreight/cli-agent)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **Note on naming:** This is **Warp Freight Network** ([wearewarp.com](https://www.wearewarp.com)) — the U.S. freight network for shipping real LTL, FTL, box truck, and cargo van freight via AI agents. Not affiliated with warp.dev, the AI-native terminal application for developers. If you want to book real freight from the command line or from Claude/Cursor/AI agents, you're in the right place.

**The AI-agent CLI for [Warp Freight Network](https://wearewarp.com).** One command
creates a Warp account, issues an API key, and wires the
[`warp-agent-mcp`](https://www.npmjs.com/package/warp-agent-mcp) server
([source](https://github.com/warpfreight/warp-agent-mcp)) into
Claude Desktop, Cursor, and Claude Code automatically. Docs at
<https://www.wearewarp.com/agents/cli>.

Looking for the full human-operator CLI (more ops surface, CSV output,
homebrew)? See [@wearewarp.com/cli](https://www.npmjs.com/package/@wearewarp.com/cli)
— docs at <https://developer.wearewarp.com/docs/cli>. Both share the same backend.

## Install

```bash
npm install -g @warpfreight/cli-agent
```

Requires Node 20+.

## Quick start

```bash
# Create an account, get a key, and auto-wire the MCP into every AI client
warp-agent signup

# Or, if you already have a Warp account:
warp-agent login
```

That single command:

1. Provisions a Warp account (or logs into an existing one)
2. Saves your `wak_live_*` + `wak_test_*` keys to `~/.warp/config.json`
3. Installs the `warp-agent-mcp` server into Claude Desktop, Cursor, and Claude Code
4. Tells you to restart your AI client

After restart, talk to your AI agent:

```
Quote LTL from 90007 to 90038 pickup June 25, 2 pallets 500 lb each.
```

## Add a payment method

<https://www.wearewarp.com/agents/account>

## CLI commands

| Command | Purpose |
|---|---|
| `warp-agent signup` | Create a new Warp account, save keys, auto-wire MCP |
| `warp-agent login` | Log in to existing Warp account, save keys, auto-wire MCP |
| `warp-agent logout` | Clear saved credentials |
| `warp-agent whoami` | Show logged-in email + key prefix |
| `warp-agent status` | API health check + key validation |
| `warp-agent install-mcp` | Re-run the MCP install (idempotent, useful after installing a new AI client) |
| `warp-agent van quote ZIP ZIP --pallets N --weight LBS --date YYYY-MM-DD` | Cargo van quote |
| `warp-agent box-truck quote ZIP ZIP --pallets N --weight LBS --date YYYY-MM-DD` | Box truck quote |
| `warp-agent ftl quote ZIP ZIP --date YYYY-MM-DD` | Full truckload quote |
| `warp-agent ltl quote ZIP ZIP --pallets N --weight LBS --dims LxWxH --date YYYY-MM-DD` | LTL quote |
| `warp-agent book QUOTE_ID --pickup-* --delivery-*` | Book a quoted shipment |
| `warp-agent track SHIPMENT_ID` | Track a shipment |
| `warp-agent events SHIPMENT_ID` | Tracking event timeline |
| `warp-agent invoice ORDER_ID` | Shipment invoice |
| `warp-agent documents ORDER_ID --type bol` | Shipment documents (use `--type bol` for the Bill of Lading) |
| `warp-agent bookings` | List recent bookings |
| `warp-agent lanes` | Lane history |
| `warp-agent quote-history` | List recent quotes |

All commands accept `--help` for full option listings, and `--format json` /
`--format table` to control output.

## Configuration

`~/.warp/config.json` holds your credentials:

```json
{
  "api_key": "wak_live_...",
  "sandbox_api_key": "wak_test_...",
  "email": "you@example.com"
}
```

| Env var | Purpose |
|---|---|
| `WARP_API_KEY` | API key fallback if config.json is missing |
| `WARP_API_URL` | Override API base URL (defaults to the warp-site proxy) |

## Sandbox mode

Swap the `api_key` field in `~/.warp/config.json` for your `sandbox_api_key` to
run against test mode — same responses, no carrier dispatch, no Stripe charge.

## Companion package

[`warp-agent-mcp`](https://www.npmjs.com/package/warp-agent-mcp) — the MCP
server this CLI auto-installs. 20 tools covering quote / book / track / cancel
/ events / invoice / documents / lane history / list bookings / rate card /
quote history / login / payment status / status / analytics for LTL, FTL,
cargo van, box truck, and multi-stop FTL.

## Contributing

Issues and PRs welcome at <https://github.com/warpfreight/warp-cli-agent>.

## License

[MIT](./LICENSE) © Warp Technology, Inc.
