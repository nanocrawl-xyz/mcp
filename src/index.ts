#!/usr/bin/env node
/**
 * NanoCrawl MCP Server — agent-side buyer for pay-per-page web browsing.
 *
 * Tools exposed to AI agents:
 *   browse(url)      — pay for and retrieve web content
 *   peek(url)        — check price without paying
 *   get_balance()    — check wallet + Gateway funds
 *   get_receipts()   — list past payments
 *   set_budget(max)  — set spending cap
 *
 * Uses Circle Nanopayments (x402) for gas-free USDC micropayments on Arc Testnet.
 * Transport: stdio (JSON-RPC over stdin/stdout for Claude Code integration).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { randomBytes } from "crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { privateKeyToAccount } from "viem/accounts";
// @ts-ignore — SDK subpath export types don't resolve under all tsconfig modes
import { GatewayClient } from "@circle-fin/x402-batching/client";

// ── Wallet Management ─────────────────────────────────────────────────────
// Auto-generates a wallet on first run; stores at ~/.nanocrawl/wallet.json.
// No private key needs to appear in commands, env vars, or config files.

const WALLET_DIR = join(homedir(), ".nanocrawl");
const WALLET_PATH = join(WALLET_DIR, "wallet.json");

function getOrCreateWallet(): `0x${string}` {
  // 1. Env var takes priority (for CI, testing, or explicit override)
  const envKey = process.env.NANOCRAWL_BUYER_PRIVATE_KEY;
  if (envKey) {
    return (envKey.startsWith("0x") ? envKey : `0x${envKey}`) as `0x${string}`;
  }

  // 2. Read from ~/.nanocrawl/wallet.json
  if (existsSync(WALLET_PATH)) {
    try {
      const data = JSON.parse(readFileSync(WALLET_PATH, "utf-8"));
      if (data.privateKey) {
        return data.privateKey as `0x${string}`;
      }
    } catch {
      // Corrupted file — regenerate
    }
  }

  // 3. Generate a new wallet
  const key = `0x${randomBytes(32).toString("hex")}` as `0x${string}`;
  const address = privateKeyToAccount(key).address;

  mkdirSync(WALLET_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(
    WALLET_PATH,
    JSON.stringify({ privateKey: key, address }, null, 2),
    { mode: 0o600 } // owner-only read/write
  );

  return key;
}

// ── Configuration ──────────────────────────────────────────────────────────

const CHAIN = "arcTestnet" as const;
const AUTO_DEPOSIT_AMOUNT = process.env.NANOCRAWL_AUTO_DEPOSIT ?? "1";
const MIN_GATEWAY_BALANCE_USDC = 0.0001;
const USDC_DECIMALS = 6;

// ── In-Memory State ────────────────────────────────────────────────────────

interface Receipt {
  url: string;
  amountUsdc: string;
  transaction: string;
  timestamp: string;
  content: string;
}

const receipts: Receipt[] = [];
const contentCache = new Map<string, Receipt>(); // URL → cached result (idempotency)
let totalSpendUsdc = 0;
let budgetCapUsdc: number = Number.isFinite(
  parseFloat(process.env.NANOCRAWL_BUDGET ?? "")
)
  ? parseFloat(process.env.NANOCRAWL_BUDGET!)
  : Infinity;

// ── GatewayClient ──────────────────────────────────────────────────────────

const privateKey = getOrCreateWallet();
const client = new GatewayClient({ chain: CHAIN, privateKey });

// ── Helpers ────────────────────────────────────────────────────────────────

function log(msg: string) {
  // Must use stderr — stdout is the JSON-RPC transport.
  process.stderr.write(`[nanocrawl] ${msg}\n`);
}

async function ensureGatewayBalance(): Promise<void> {
  const balances = await client.getBalances();
  const available = parseFloat(balances?.gateway?.formattedAvailable ?? "0");

  if (available >= MIN_GATEWAY_BALANCE_USDC) return;

  const walletBalance = parseFloat(balances?.wallet?.formatted ?? "0");
  const depositAmt = parseFloat(AUTO_DEPOSIT_AMOUNT);

  if (walletBalance < depositAmt) {
    throw new Error(
      `Insufficient funds. Wallet: ${walletBalance} USDC, Gateway: ${available} USDC. ` +
        `Fund at https://faucet.circle.com (select Arc Testnet).`
    );
  }

  log(`Gateway balance low (${available} USDC), depositing ${AUTO_DEPOSIT_AMOUNT} USDC...`);
  const deposit = await client.deposit(AUTO_DEPOSIT_AMOUNT);
  log(`Deposit tx: ${deposit.depositTxHash}`);
  log(`Deposited ${deposit.formattedAmount} USDC into Gateway`);
}

// ── Proactive Payment Flow ─────────────────────────────────────────────────
// Parses robots.txt once per domain, caches payment metadata, then constructs
// EIP-3009 authorizations locally — skipping the 402 round-trip entirely.
// First browse() to a domain uses the standard flow; subsequent calls use proactive.

interface DomainPaymentMeta {
  network: string;
  chainId: number;
  asset: string;
  payTo: string;
  verifyingContract: string;
  maxTimeoutSeconds: number;
  crawlFeeUsdc: number;
}

const domainMetaCache = new Map<string, DomainPaymentMeta>();

function parseRobotsTxt(text: string): DomainPaymentMeta | null {
  const get = (key: string) =>
    text.match(new RegExp(`${key}:\\s*(.+)`, "i"))?.[1]?.trim();

  const payTo = get("Payment-PayTo");
  const network = get("Payment-Network");
  const asset = get("Payment-Asset");
  const vc = get("Payment-VerifyingContract");
  const feeStr = get("Crawl-fee");

  if (!payTo || !network || !asset || !vc || !feeStr) return null;
  const crawlFeeUsdc = parseFloat(feeStr);
  if (isNaN(crawlFeeUsdc)) return null;

  return {
    network,
    chainId: parseInt(network.split(":")[1], 10),
    asset,
    payTo,
    verifyingContract: vc,
    maxTimeoutSeconds: parseInt(get("Payment-MaxTimeoutSeconds") ?? "345600", 10),
    crawlFeeUsdc,
  };
}

async function getDomainMeta(url: string): Promise<DomainPaymentMeta | null> {
  const origin = new URL(url).origin;
  if (domainMetaCache.has(origin)) return domainMetaCache.get(origin)!;

  try {
    const res = await fetch(`${origin}/robots.txt`, {
      headers: { "User-Agent": "NanoCrawl/1.0" },
    });
    if (!res.ok) return null;
    const meta = parseRobotsTxt(await res.text());
    if (meta) {
      domainMetaCache.set(origin, meta);
      log(`Cached payment metadata for ${origin} (${meta.crawlFeeUsdc} USDC/page)`);
    }
    return meta;
  } catch {
    return null;
  }
}

async function proactiveBrowse(
  url: string
): Promise<{ data: unknown; formattedAmount: string; transaction: string; status: number } | null> {
  const meta = await getDomainMeta(url);
  if (!meta) return null;

  const amountUnits = Math.round(meta.crawlFeeUsdc * 10 ** USDC_DECIMALS).toString();
  const nonce = `0x${randomBytes(32).toString("hex")}` as `0x${string}`;
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 5 * 24 * 60 * 60);

  // Sign EIP-3009 TransferWithAuthorization using EIP-712 (GatewayWalletBatched domain)
  const authorization = {
    from: client.address,
    to: meta.payTo as `0x${string}`,
    value: amountUnits,
    validAfter: "0",
    validBefore: validBefore.toString(),
    nonce,
  };

  const signature = await client.account.signTypedData({
    domain: {
      name: "GatewayWalletBatched",
      version: "1",
      chainId: meta.chainId,
      verifyingContract: meta.verifyingContract as `0x${string}`,
    },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization" as const,
    message: {
      from: client.address,
      to: meta.payTo as `0x${string}`,
      value: BigInt(amountUnits),
      validAfter: 0n,
      validBefore,
      nonce,
    },
  });

  // Build x402 v2 PAYMENT-SIGNATURE payload
  const paymentPayload = {
    x402Version: 2,
    resource: { url, mimeType: "application/json", description: "NanoCrawl paid content" },
    accepted: {
      scheme: "exact",
      network: meta.network,
      asset: meta.asset,
      amount: amountUnits,
      payTo: meta.payTo,
      maxTimeoutSeconds: meta.maxTimeoutSeconds,
      extra: {
        name: "GatewayWalletBatched",
        version: "1",
        verifyingContract: meta.verifyingContract,
      },
    },
    payload: { signature, authorization },
  };

  const encoded = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");

  // Single request — payment attached upfront, no 402 round-trip
  const res = await fetch(url, {
    headers: {
      "User-Agent": "NanoCrawl/1.0 (AI agent; +https://nanocrawl.vercel.app)",
      "X-NanoCrawl-Capable": "true",
      "Payment-Signature": encoded,
    },
    redirect: "follow",
  });

  if (res.status !== 200) return null;

  // Extract settlement ID from PAYMENT-RESPONSE header
  let transaction = "proactive";
  const prHeader = res.headers.get("payment-response");
  if (prHeader) {
    try {
      const pr = JSON.parse(Buffer.from(prHeader, "base64").toString("utf-8"));
      transaction = pr.transaction ?? "proactive";
    } catch { /* use default */ }
  }

  const data = await res.json().catch(() => res.text());
  return { data, formattedAmount: meta.crawlFeeUsdc.toFixed(6), transaction, status: 200 };
}

// ── MCP Server Setup ───────────────────────────────────────────────────────

const server = new McpServer(
  { name: "nanocrawl", version: "0.1.0" },
  {
    instructions:
      "NanoCrawl MCP server — pay-per-page web browsing for AI agents via " +
      "Circle Nanopayments. Use browse() to fetch paid content, peek() to " +
      "check prices, get_balance() for funds, set_budget() for spending limits.",
  }
);

// ── Tool: browse ───────────────────────────────────────────────────────────
// GatewayClient.pay() handles the full x402 flow internally:
//   1. GET url → receives 402 + PAYMENT-REQUIRED header
//   2. Parses payment requirements (price, payTo, network, verifyingContract)
//   3. Signs EIP-3009 authorization off-chain (zero gas)
//   4. Retries request with PAYMENT-SIGNATURE header
//   5. Returns content + settlement metadata

server.registerTool(
  "browse",
  {
    description:
      "Pay for and retrieve content from a URL that charges AI crawlers " +
      "via x402/Circle Nanopayments. Handles payment automatically.",
    inputSchema: {
      url: z.string().url().describe("The URL to browse and pay for"),
    },
  },
  async ({ url }: { url: string }) => {
    // Idempotency: return cached content if we already paid for this URL
    const cached = contentCache.get(url);
    if (cached) {
      log(`Cache hit for ${url} (paid ${cached.amountUsdc} USDC earlier)`);
      return {
        content: [
          {
            type: "text" as const,
            text:
              `[Cached — already paid ${cached.amountUsdc} USDC | TX: ${cached.transaction}]\n\n` +
              cached.content,
          },
        ],
      };
    }

    if (totalSpendUsdc >= budgetCapUsdc) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Budget exhausted. Spent: ${totalSpendUsdc.toFixed(6)} USDC, ` +
              `Cap: ${budgetCapUsdc.toFixed(6)} USDC. Use set_budget to increase.`,
          },
        ],
        isError: true,
      };
    }

    try {
      await ensureGatewayBalance();

      // Try proactive flow first (single request, no 402 round-trip)
      let result: { data: unknown; formattedAmount: string; transaction: string; status: number };
      let flowType: string;

      const proactive = await proactiveBrowse(url).catch(() => null);
      if (proactive) {
        result = proactive;
        flowType = "proactive";
      } else {
        // Fall back to standard 2-request flow
        result = await client.pay(url);
        flowType = "standard";
        // Cache domain metadata for future proactive calls
        getDomainMeta(url).catch(() => {});
      }

      const amountUsdc = parseFloat(result.formattedAmount);
      totalSpendUsdc += amountUsdc;

      const content =
        typeof result.data === "string"
          ? result.data
          : JSON.stringify(result.data, null, 2);

      const receipt: Receipt = {
        url,
        amountUsdc: result.formattedAmount,
        transaction: result.transaction,
        timestamp: new Date().toISOString(),
        content,
      };

      receipts.push(receipt);
      contentCache.set(url, receipt);

      log(`[${flowType}] Paid ${result.formattedAmount} USDC for ${url} (tx: ${result.transaction})`);

      const budgetNote =
        budgetCapUsdc !== Infinity
          ? `\nBudget: ${totalSpendUsdc.toFixed(6)} / ${budgetCapUsdc.toFixed(6)} USDC`
          : "";

      return {
        content: [
          {
            type: "text" as const,
            text:
              `[${flowType}] Paid ${result.formattedAmount} USDC | TX: ${result.transaction}${budgetNote}\n\n` +
              content,
          },
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Failed to browse ${url}: ${msg}` }],
        isError: true,
      };
    }
  }
);

// ── Tool: peek ─────────────────────────────────────────────────────────────
// Manual HTTP — we want the 402 response, NOT to pay.
// Node.js fetch() naturally lacks accept-language and sec-fetch-dest headers,
// so the publisher's classifier (web/lib/classify.ts) will identify us as a
// crawler and return 402 with pricing info.

server.registerTool(
  "peek",
  {
    description:
      "Check the price of a URL without paying. Returns pricing info " +
      "if the site charges AI crawlers via x402.",
    inputSchema: {
      url: z.string().url().describe("The URL to check pricing for"),
    },
  },
  async ({ url }: { url: string }) => {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "NanoCrawl/1.0 (AI agent; +https://nanocrawl.vercel.app)",
          "X-NanoCrawl-Capable": "true",
        },
        redirect: "follow",
      });

      if (res.status === 402) {
        // Try PAYMENT-REQUIRED header (base64-encoded JSON), then response body
        let requirements: Record<string, unknown> | null = null;

        const header = res.headers.get("payment-required");
        if (header) {
          try {
            requirements = JSON.parse(
              Buffer.from(header, "base64").toString("utf-8")
            );
          } catch {
            // Fall through to body parsing
          }
        }
        if (!requirements) {
          requirements = (await res.json().catch(() => null)) as Record<
            string,
            unknown
          > | null;
        }

        const accepts = requirements?.accepts as Array<Record<string, unknown>> | undefined;
        const accept = accepts?.[0];

        if (!accept) {
          return {
            content: [
              {
                type: "text" as const,
                text: "402 received but could not parse payment options.",
              },
            ],
            isError: true,
          };
        }

        const amountUnits = parseInt(String(accept.amount), 10);
        const amountUsdc = amountUnits / 10 ** USDC_DECIMALS;
        const extra = accept.extra as Record<string, string> | undefined;

        return {
          content: [
            {
              type: "text" as const,
              text: [
                `Price: ${amountUsdc} USDC`,
                `Network: ${accept.network}`,
                `Pay to: ${accept.payTo}`,
                `Scheme: ${extra?.name ?? accept.scheme}`,
              ].join("\n"),
            },
          ],
        };
      }

      if (res.status === 200) {
        return {
          content: [
            { type: "text" as const, text: "This URL is free — no payment required." },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `HTTP ${res.status} — not a paid resource.`,
          },
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Failed to peek ${url}: ${msg}` }],
        isError: true,
      };
    }
  }
);

// ── Tool: get_balance ──────────────────────────────────────────────────────

server.registerTool(
  "get_balance",
  {
    description:
      "Check USDC balances (on-chain wallet and Circle Gateway) plus session spending.",
    inputSchema: {},
  },
  async () => {
    try {
      const b = await client.getBalances();
      const remaining =
        budgetCapUsdc === Infinity
          ? "unlimited"
          : `${Math.max(0, budgetCapUsdc - totalSpendUsdc).toFixed(6)} USDC`;

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Wallet (on-chain): ${b?.wallet?.formatted ?? "?"} USDC`,
              `Gateway available:  ${b?.gateway?.formattedAvailable ?? "?"} USDC`,
              `Gateway total:      ${b?.gateway?.formattedTotal ?? "?"} USDC`,
              `Session spend:      ${totalSpendUsdc.toFixed(6)} USDC`,
              `Budget remaining:   ${remaining}`,
              `Address: ${client.address}`,
              `Chain:   ${CHAIN}`,
            ].join("\n"),
          },
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Failed to get balance: ${msg}` }],
        isError: true,
      };
    }
  }
);

// ── Tool: get_receipts ─────────────────────────────────────────────────────

server.registerTool(
  "get_receipts",
  {
    description:
      "List all payments made this session — URLs, amounts, transaction IDs.",
    inputSchema: {},
  },
  async () => {
    if (receipts.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No payments made this session." }],
      };
    }

    const lines = receipts.map(
      (r, i) =>
        `${i + 1}. ${r.url}\n   ${r.amountUsdc} USDC | TX: ${r.transaction} | ${r.timestamp}`
    );

    return {
      content: [
        {
          type: "text" as const,
          text:
            `${receipts.length} payments | ${totalSpendUsdc.toFixed(6)} USDC total\n\n` +
            lines.join("\n"),
        },
      ],
    };
  }
);

// ── Tool: set_budget ───────────────────────────────────────────────────────

server.registerTool(
  "set_budget",
  {
    description:
      "Set a USDC spending cap for this session. browse() will refuse once the cap is reached.",
    inputSchema: {
      max_usd: z
        .number()
        .positive()
        .describe("Maximum USDC to spend (e.g. 0.05 for 5 cents)"),
    },
  },
  async ({ max_usd }: { max_usd: number }) => {
    budgetCapUsdc = max_usd;
    const remaining = Math.max(0, budgetCapUsdc - totalSpendUsdc);
    return {
      content: [
        {
          type: "text" as const,
          text:
            `Budget: ${budgetCapUsdc} USDC | ` +
            `Spent: ${totalSpendUsdc.toFixed(6)} | ` +
            `Remaining: ${remaining.toFixed(6)} USDC`,
        },
      ],
    };
  }
);

// ── Startup ────────────────────────────────────────────────────────────────

async function main() {
  // When run directly in a terminal (not piped by Claude Code), show setup info
  if (process.stdin.isTTY) {
    const isNew = !existsSync(WALLET_PATH) && !process.env.NANOCRAWL_BUYER_PRIVATE_KEY;
    console.log("");
    console.log("  NanoCrawl MCP Server");
    console.log("  ────────────────────");
    if (isNew) {
      console.log("  Status:   New wallet created");
    }
    console.log(`  Address:  ${client.address}`);
    console.log(`  Chain:    Arc Testnet`);
    console.log(`  Wallet:   ${WALLET_PATH}`);
    console.log("");
    try {
      const b = await client.getBalances();
      const onChain = parseFloat(b?.wallet?.formatted ?? "0");
      const gateway = parseFloat(b?.gateway?.formattedAvailable ?? "0");
      console.log(`  On-chain: ${b?.wallet?.formatted ?? "0"} USDC`);
      console.log(`  Gateway:  ${b?.gateway?.formattedAvailable ?? "0"} USDC`);
      if (onChain === 0 && gateway === 0) {
        console.log("");
        console.log("  Wallet is empty. Please deposit USDC:");
        console.log("  https://faucet.circle.com");
        console.log("  (select Arc Testnet, paste the address above)");
      }
    } catch {
      console.log("  Balance:  could not connect");
      console.log("");
      console.log("  Please deposit USDC to this address:");
      console.log("  https://faucet.circle.com");
      console.log("  (select Arc Testnet, paste the address above)");
    }
    console.log("");
    console.log("  Add to Claude Code:");
    console.log("  claude mcp add nanocrawl -- npx nanocrawl");
    console.log("");
    process.exit(0);
  }

  // Running as MCP server (stdin piped by Claude Code)
  log("Starting NanoCrawl MCP server...");
  log(`Address: ${client.address}`);
  log(`Chain: ${CHAIN}`);

  try {
    const b = await client.getBalances();
    log(`Wallet: ${b?.wallet?.formatted ?? "?"} USDC`);
    log(`Gateway: ${b?.gateway?.formattedAvailable ?? "?"} USDC`);
    await ensureGatewayBalance();
  } catch (err) {
    log(`Warning: initial balance check failed — ${err instanceof Error ? err.message : err}`);
    log("Payments will attempt deposit on first browse() call.");
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("Connected via stdio — ready for tool calls");
}

main().catch((err) => {
  log(`Fatal: ${err}`);
  process.exit(1);
});
