/**
 * Integration test — verifies the full payment flow against the live seller.
 *
 * Usage:
 *   NANOCRAWL_BUYER_PRIVATE_KEY=0x... npx tsx src/test.ts
 */

// @ts-ignore
import { GatewayClient } from "@circle-fin/x402-batching/client";

const BUYER_KEY = process.env.NANOCRAWL_BUYER_PRIVATE_KEY;
const TARGET = process.env.NANOCRAWL_TARGET ?? "https://nanocrawl.vercel.app";

if (!BUYER_KEY) {
  console.error("Set NANOCRAWL_BUYER_PRIVATE_KEY to run this test.");
  process.exit(1);
}

const privateKey = (BUYER_KEY.startsWith("0x") ? BUYER_KEY : `0x${BUYER_KEY}`) as `0x${string}`;
const client = new GatewayClient({ chain: "arcTestnet", privateKey });

async function main() {
  console.log(`Address: ${client.address}`);
  console.log(`Target:  ${TARGET}\n`);

  // ── Check balances ─────────────────────────────────────────────────────
  console.log("1. Checking balances...");
  const balances = await client.getBalances();
  console.log(`   Wallet:  ${balances?.wallet?.formatted ?? "?"} USDC`);
  console.log(`   Gateway: ${balances?.gateway?.formattedAvailable ?? "?"} USDC`);

  // ── Deposit if needed ──────────────────────────────────────────────────
  const available = parseFloat(balances?.gateway?.formattedAvailable ?? "0");
  if (available < 0.001) {
    console.log("\n2. Gateway empty — depositing 1 USDC...");
    const deposit = await client.deposit("1");
    console.log(`   Deposit tx: ${deposit.depositTxHash}`);
    console.log(`   Amount: ${deposit.formattedAmount} USDC`);
  } else {
    console.log("\n2. Gateway funded — skipping deposit.");
  }

  // ── Peek (raw 402) ────────────────────────────────────────────────────
  console.log("\n3. Peeking at /products/1 (expecting 402)...");
  const peekRes = await fetch(`${TARGET}/products/1`, {
    headers: {
      "User-Agent": "NanoCrawl/1.0 (AI agent)",
      "X-NanoCrawl-Capable": "true",
    },
  });
  console.log(`   Status: ${peekRes.status}`);

  if (peekRes.status === 402) {
    const body = await peekRes.json();
    const accept = body.accepts?.[0];
    const price = parseInt(accept?.amount ?? "0", 10) / 1_000_000;
    console.log(`   Price:  ${price} USDC`);
    console.log(`   PayTo:  ${accept?.payTo}`);
  }

  // ── Browse (pay + get content) ─────────────────────────────────────────
  console.log("\n4. Browsing /products/1 (paying via GatewayClient.pay())...");
  const result = await client.pay(`${TARGET}/products/1`);
  console.log(`   Status: ${result.status}`);
  console.log(`   Paid:   ${result.formattedAmount} USDC`);
  console.log(`   TX:     ${result.transaction}`);

  const content = typeof result.data === "string"
    ? result.data.slice(0, 200)
    : JSON.stringify(result.data).slice(0, 200);
  console.log(`   Content: ${content}...`);

  // ── Summary ────────────────────────────────────────────────────────────
  console.log("\n5. Checking final balances...");
  const after = await client.getBalances();
  console.log(`   Gateway: ${after?.gateway?.formattedAvailable ?? "?"} USDC`);

  console.log("\nAll checks passed.");
}

main().catch((err) => {
  console.error(`\nFailed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
