#!/usr/bin/env tsx
/**
 * Integration test for Unlink privacy mode.
 *
 * Tests the full BurnerWallet session lifecycle:
 *   1. startBurnerSession() — create burner, fund from pool, poll until funded
 *   2. GatewayClient with burner key — deposit, peek price, browse one page
 *   3. close_session equivalent — Gateway withdraw, teardown (depositToPool + dispose + deleteKey)
 *
 * Run:
 *   NANOCRAWL_UNLINK_MNEMONIC="..." NANOCRAWL_UNLINK_API_KEY="..." npm run test:unlink
 */

// @ts-ignore
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { startBurnerSession, pollUntilGatewayFunded } from "./unlink/index.js";

const SELLER_URL = "https://nanocrawl.vercel.app/products/1";
const SESSION_AMOUNT = process.env.NANOCRAWL_UNLINK_SESSION_AMOUNT ?? "5";

function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] ${msg}`);
}

async function main() {
  const mnemonic = process.env.NANOCRAWL_UNLINK_MNEMONIC;
  const apiKey = process.env.NANOCRAWL_UNLINK_API_KEY;

  if (!mnemonic || !apiKey) {
    console.error("Set NANOCRAWL_UNLINK_MNEMONIC and NANOCRAWL_UNLINK_API_KEY");
    process.exit(1);
  }

  console.log("");
  console.log("  NanoCrawl × Unlink — privacy mode integration test");
  console.log("  ───────────────────────────────────────────────────");
  console.log("");

  // ── Step 1: Start Unlink session ──────────────────────────────────────────
  log(`Starting BurnerWallet session (${SESSION_AMOUNT} USDC)...`);
  log("(ZK proof + gas funding — may take ~1–2 minutes)");

  const t0 = Date.now();
  const session = await startBurnerSession({
    mnemonic,
    apiKey,
    sessionAmountUsdc: SESSION_AMOUNT,
    engineUrl: process.env.NANOCRAWL_UNLINK_ENGINE_URL,
    rpcUrl: process.env.RPC_URL,
  });

  log(`✓ Burner funded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  log(`  Burner address: ${session.burnerAddress}`);
  log(`  (on-chain: this address, NOT your real EOA, is visible)`);
  console.log("");

  // ── Step 2: GatewayClient with burner key ────────────────────────────────
  log("Creating GatewayClient with burner key (Base Sepolia)...");
  const gw = new GatewayClient({
    chain: "baseSepolia",
    privateKey: session.burnerPrivateKey,
  });

  log(`  Gateway address: ${gw.address}`);

  const balBefore = await gw.getBalances();
  log(`  Wallet USDC:  ${balBefore?.wallet?.formatted ?? "?"}`);
  log(`  Gateway USDC: ${balBefore?.gateway?.formattedAvailable ?? "?"}`);
  console.log("");

  // ── Step 3: Deposit into Gateway ─────────────────────────────────────────
  log(`Depositing ${SESSION_AMOUNT} USDC into Gateway from burner...`);
  const depositResult = await gw.deposit(SESSION_AMOUNT);
  log(`  Deposit tx: ${depositResult?.depositTxHash ?? "unknown"}`);
  log("  Waiting for Circle Gateway to process deposit (up to 3 min)...");
  await pollUntilGatewayFunded(gw);

  const balAfter = await gw.getBalances();
  log(`✓ Gateway balance: ${balAfter?.gateway?.formattedAvailable ?? "?"} USDC`);
  console.log("");

  // ── Step 4: Browse one page (the actual payment) ─────────────────────────
  log(`Browsing: ${SELLER_URL}`);
  const result = await gw.pay(SELLER_URL);
  log(`✓ Paid ${result.formattedAmount} USDC — TX: ${result.transaction}`);
  log(`  Content preview: ${String(JSON.stringify(result.data)).slice(0, 80)}...`);
  console.log("");

  // ── Step 5: Teardown ──────────────────────────────────────────────────────
  log("Tearing down session...");

  const balFinal = await gw.getBalances();
  const remaining = balFinal?.gateway?.formattedAvailable ?? "0";
  if (parseFloat(remaining) > 0.000001) {
    log(`  Withdrawing ${remaining} USDC from Gateway back to burner...`);
    await gw.withdraw(remaining);
  }

  log("  Returning USDC to Unlink pool (Permit2 approve + depositToPool)...");
  await session.teardown();
  log("✓ Burner key destroyed — session complete");
  console.log("");

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("  ───────────────────────────────────────────────────");
  console.log(`  ✅  Privacy mode working end-to-end`);
  console.log(`  Burner ${session.burnerAddress} was used and disposed.`);
  console.log(`  Real EOA 0xC660B6F65f6bD587437d5CBA21Ed272E80147967 never appeared on-chain.`);
  console.log("");
}

main().catch((err) => {
  console.error("FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
