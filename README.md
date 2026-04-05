# nanocrawl

MCP server that gives any AI agent a wallet to pay for web content.

AI agents call `browse(url)` and get content back. Payment happens automatically — the agent never touches private keys or knows about x402.

```
npm install -g nanocrawl
```

## Setup

**1. Run once** to generate your wallet:

```bash
npx nanocrawl
```

This creates a wallet at `~/.nanocrawl/wallet.json` and prints the address. Fund it at [faucet.circle.com](https://faucet.circle.com) (select Arc Testnet).

**2. Add to Claude Code:**

```bash
claude mcp add nanocrawl -- npx nanocrawl
```

**3. Start browsing paid content:**

```
> browse https://shop-cannes.vercel.app/products/1
> What's the current price of ETH? (browse https://coin-cannes.vercel.app/coins/ethereum)
> Find me a Thai curry recipe (browse https://demo-chef.vercel.app/recipes/5)
```

## Tools

| Tool | Description |
|------|-------------|
| `browse(url)` | Pay for and retrieve content from a URL. Handles the full x402 payment flow automatically. |
| `peek(url)` | Check the price of a URL without paying. Returns pricing info if the site charges crawlers. |
| `get_balance()` | Check wallet balance (on-chain + Circle Gateway), session spending, and budget remaining. |
| `set_budget(max)` | Set a USDC spending cap for this session. `browse()` will refuse once the cap is reached. |
| `get_receipts()` | List all payments made this session — URLs, amounts, and transaction IDs. |

## How It Works

```
Agent calls browse(url)
    │
    ├─ Proactive flow (fast, 1 request):
    │   Reads robots.txt → signs EIP-3009 off-chain → sends payment with first request
    │
    └─ Reactive flow (fallback, 2 requests):
        GET url → 402 + pricing → signs payment → retries with PAYMENT-SIGNATURE header
    │
    ▼
Content returned to agent. Payment settled via Circle Gateway (gas-free USDC).
```

The server tries the **proactive flow** first — parsing `robots.txt` for payment metadata and attaching a signed payment on the first request. No 402 round-trip needed. If the site doesn't publish payment metadata in `robots.txt`, it falls back to the standard 2-request flow.

## Wallet

On first run, a wallet is auto-generated and stored at `~/.nanocrawl/wallet.json` (owner-only permissions). No private key ever appears in commands, env vars, or config files.

To use an existing key, set `NANOCRAWL_BUYER_PRIVATE_KEY` in your environment.

## Configuration

All configuration is via environment variables (all optional):

| Variable | Default | Description |
|----------|---------|-------------|
| `NANOCRAWL_BUYER_PRIVATE_KEY` | auto-generated | Use a specific private key instead of the auto-generated wallet |
| `NANOCRAWL_BUDGET` | unlimited | Session spending cap in USDC (e.g. `0.05`) |
| `NANOCRAWL_AUTO_DEPOSIT` | `1` | USDC to auto-deposit into Gateway when balance is low |

## Example Session

```
You: browse https://demo-chef.vercel.app/recipes/3

NanoCrawl: [proactive] Paid 0.002000 USDC | TX: a3f1b2c4-...

# Thai Green Curry
**Cuisine:** Thai | **Prep:** 15 min | **Cook:** 25 min | **Servings:** 4

## Ingredients
- 400ml coconut milk
- 2 tbsp green curry paste
- 300g chicken breast, sliced
...

You: get_balance

NanoCrawl:
Wallet (on-chain): 18.994 USDC
Gateway available:  0.972 USDC
Session spend:      0.002000 USDC
Budget remaining:   unlimited

You: get_receipts

NanoCrawl:
1 payment | 0.002000 USDC total

1. https://demo-chef.vercel.app/recipes/3
   0.002000 USDC | TX: a3f1b2c4-... | 2026-04-05T10:30:00Z
```

## Removing

```bash
claude mcp remove nanocrawl
```

## The Ecosystem

| Package | Role |
|---------|------|
| **nanocrawl** (`npx nanocrawl`) | Agent side — MCP server that gives AI agents a wallet to pay for content |
| **nanocrawl-sdk** (`npm install nanocrawl-sdk`) | Publisher side — paywall + dashboard for Next.js sites |

## Links

- [NanoCrawl](https://nanocrawl.vercel.app)
- [Circle Nanopayments](https://developers.circle.com/gateway/nanopayments)
- [x402 Protocol](https://www.x402.org)
- [MCP Specification](https://modelcontextprotocol.io)

## License

MIT
