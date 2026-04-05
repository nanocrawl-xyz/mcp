#!/usr/bin/env tsx
/**
 * NanoCrawl × Unlink — privacy mode integration test
 *
 * npm run test:unlink       → Option C: Arc Testnet payments (working workaround)
 * npm run test:unlink:base  → Base Sepolia (shows Circle indexer gap — for Arc team demo)
 */

// @ts-ignore
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { startBurnerSession, pollUntilGatewayFunded } from "./unlink/index.js";
import {
  createWalletClient,
  createPublicClient,
  http,
  parseUnits,
  type Address,
} from "viem";
import { arcTestnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ── Config ────────────────────────────────────────────────────────────────────

const ARC_USDC  = "0x3600000000000000000000000000000000000000" as const;
const ARC_RPC   = "https://rpc.testnet.arc.network";
const GW_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";

const SELLER_URL    = "https://nanocrawl.vercel.app/products/1";
// Normalise so ".1" in .env renders as "0.1" in output
const SESSION_AMOUNT = String(parseFloat(process.env.NANOCRAWL_UNLINK_SESSION_AMOUNT ?? "0.1"));
const PAYMENT_CHAIN  = (process.env.NANOCRAWL_UNLINK_PAYMENT_CHAIN ?? "arcTestnet") as "arcTestnet" | "baseSepolia";

// ── Explorer links ────────────────────────────────────────────────────────────

const explorer = {
  baseSepolia: {
    tx:      (h: string) => `https://sepolia.basescan.org/tx/${h}`,
    address: (a: string) => `https://sepolia.basescan.org/address/${a}`,
  },
  arcTestnet: {
    tx:      (h: string) => `https://testnet.arcscan.app/tx/${h}`,
    address: (a: string) => `https://testnet.arcscan.app/address/${a}`,
  },
};

const paymentExplorer = explorer[PAYMENT_CHAIN];

// ── Helpers ───────────────────────────────────────────────────────────────────

function step(n: number, title: string) {
  console.log(`\n  ── Step ${n}: ${title} ${"─".repeat(Math.max(0, 52 - title.length))}`);
}

function ok(msg: string)   { console.log(`  ✓ ${msg}`); }
function info(msg: string) { console.log(`    ${msg}`); }
function warn(msg: string) { console.log(`  ⚠ ${msg}`); }
function fail(msg: string) { console.log(`  ✗ ${msg}`); }

function ts() { return new Date().toISOString().slice(11, 19); }

function getRealEoaPrivateKey(): `0x${string}` {
  const envKey = process.env.NANOCRAWL_BUYER_PRIVATE_KEY;
  if (envKey) return (envKey.startsWith("0x") ? envKey : `0x${envKey}`) as `0x${string}`;
  const walletPath = join(homedir(), ".nanocrawl", "wallet.json");
  if (existsSync(walletPath)) {
    try {
      const data = JSON.parse(readFileSync(walletPath, "utf-8"));
      if (data.privateKey) return data.privateKey as `0x${string}`;
    } catch { /* fall through */ }
  }
  throw new Error("Real EOA key not found. Set NANOCRAWL_BUYER_PRIVATE_KEY or run the MCP server once.");
}

const erc20TransferAbi = [
  { inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }],
    name: "transfer", outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable", type: "function" },
] as const;

const erc20BalanceAbi = [
  { inputs: [{ name: "account", type: "address" }],
    name: "balanceOf", outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view", type: "function" },
] as const;

async function fundBurnerOnArc(
  realEoaPrivateKey: `0x${string}`,
  burnerAddress: Address,
  amountUsdc: string
): Promise<string> {
  const account      = privateKeyToAccount(realEoaPrivateKey);
  const publicClient = createPublicClient({ chain: arcTestnet, transport: http(ARC_RPC) });
  const walletClient = createWalletClient({ account, chain: arcTestnet, transport: http(ARC_RPC) });

  const balance     = (await publicClient.readContract({ address: ARC_USDC, abi: erc20BalanceAbi, functionName: "balanceOf", args: [account.address] })) as bigint;
  const amountUnits = parseUnits(amountUsdc, 6);

  info(`Real EOA Arc balance: ${(Number(balance) / 1e6).toFixed(6)} USDC`);
  if (balance < amountUnits) throw new Error(
    `Insufficient Arc Testnet USDC on real EOA (${account.address}). ` +
    `Have: ${(Number(balance) / 1e6).toFixed(6)}, Need: ${amountUsdc}. ` +
    `Fund at https://faucet.circle.com (Arc Testnet).`
  );

  const txHash = await walletClient.writeContract({ address: ARC_USDC, abi: erc20TransferAbi, functionName: "transfer", args: [burnerAddress, amountUnits] });
  await publicClient.waitForTransactionReceipt({ hash: txHash });
  return txHash;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const mnemonic = process.env.NANOCRAWL_UNLINK_MNEMONIC;
  const apiKey   = process.env.NANOCRAWL_UNLINK_API_KEY;
  if (!mnemonic || !apiKey) {
    console.error("Set NANOCRAWL_UNLINK_MNEMONIC and NANOCRAWL_UNLINK_API_KEY");
    process.exit(1);
  }

  const isBaseSepolia = PAYMENT_CHAIN === "baseSepolia";

  console.log("");
  console.log("  ══════════════════════════════════════════════════════════");
  if (isBaseSepolia) {
    console.log("  NanoCrawl × Unlink — Base Sepolia single-chain flow");
    console.log("  Purpose : Ideal fully-private flow (if Circle indexes it)");
    console.log("  Expect  : Circle Gateway indexer gap — deposit never credited");
  } else {
    console.log("  NanoCrawl × Unlink — Privacy Mode (Option C)");
    console.log("  Burner  : Base Sepolia, ZK-shielded via Unlink privacy pool");
    console.log("  Payments: Arc Testnet, Circle Gateway");
  }
  console.log("  ══════════════════════════════════════════════════════════");

  // ── Step 1: Unlink ZK burner (Base Sepolia) ───────────────────────────────
  step(1, "Unlink ZK Burner — Base Sepolia");
  console.log(`  [${ts()}] Creating ephemeral burner via ZK privacy pool...`);
  const t0 = Date.now();

  const session = await startBurnerSession({
    mnemonic,
    apiKey,
    sessionAmountUsdc: SESSION_AMOUNT,
    engineUrl: process.env.NANOCRAWL_UNLINK_ENGINE_URL,
    rpcUrl:    process.env.RPC_URL,
  });

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  ok(`Burner ready in ${elapsed}s`);
  info(`Address : ${session.burnerAddress}`);
  info(`Explorer: ${explorer.baseSepolia.address(session.burnerAddress)}`);
  info(`Real EOA: NOT visible on Base Sepolia ✓  (ZK-shielded by Unlink pool)`);

  // ── Step 2: Fund burner on payment chain ─────────────────────────────────
  const realEoaKey = getRealEoaPrivateKey();
  const realEoa    = privateKeyToAccount(realEoaKey);

  if (!isBaseSepolia) {
    step(2, "Fund Burner — Arc Testnet transfer");
    warn(`This tx links real EOA → burner on Arc Testnet (testnet-only caveat)`);
    warn(`On mainnet (single Base chain) this step does not exist — fully private`);
    info(`Real EOA: ${realEoa.address}`);
    const transferTx = await fundBurnerOnArc(realEoaKey, session.burnerAddress, SESSION_AMOUNT);
    ok(`${SESSION_AMOUNT} USDC transferred`);
    info(`Tx      : ${explorer.arcTestnet.tx(transferTx)}`);
  } else {
    step(2, "No cross-chain transfer needed");
    ok(`Burner funded by Unlink pool on Base Sepolia — real EOA never touches Arc`);
    info(`Real EOA: ${realEoa.address}`);
  }

  // ── Step 3: Circle Gateway deposit ───────────────────────────────────────
  step(3, `Circle Gateway Deposit — ${PAYMENT_CHAIN}`);
  const gw         = new GatewayClient({ chain: PAYMENT_CHAIN, privateKey: session.burnerPrivateKey });
  const balBefore  = await gw.getBalances();
  const walletUsdc = parseFloat(balBefore?.wallet?.formatted ?? "0");
  const gwTotal    = parseFloat(balBefore?.gateway?.formattedTotal ?? "0");

  info(`GatewayWallet : ${GW_WALLET}`);
  info(`Explorer      : ${paymentExplorer.address(GW_WALLET)}`);
  info(`Burner wallet : ${walletUsdc} USDC on-chain`);
  info(`Gateway total : ${gwTotal} USDC (Circle off-chain ledger)`);

  let depositTxHash: string | undefined;

  if (gwTotal > 0) {
    ok(`Gateway already funded (${gwTotal} USDC) — skipping deposit`);
  } else if (walletUsdc > 0) {
    console.log(`\n  [${ts()}] Depositing ${SESSION_AMOUNT} USDC: burner → GatewayWallet...`);
    const depositResult = await gw.deposit(SESSION_AMOUNT);
    depositTxHash = depositResult?.depositTxHash;
    ok(`Deposit tx confirmed on-chain`);
    info(`Tx      : ${paymentExplorer.tx(depositTxHash ?? "unknown")}`);
    info(`Waiting for Circle Gateway to index deposit...`);
    await pollUntilGatewayFunded(gw, 30_000, 3_000, (n, elapsed, total, avail) => {
      if (total > 0 || avail > 0) ok(`Gateway indexed — total=${total} available=${avail}  (poll #${n}, ${elapsed})`);
      else info(`poll #${String(n).padStart(2)}  [${elapsed} elapsed]  total=0 available=0  — waiting...`);
    });
  } else {
    info(`Wallet empty — previous deposit on-chain, waiting for Circle to index...`);
    await pollUntilGatewayFunded(gw, 30_000, 3_000, (n, elapsed, total, avail) => {
      if (total > 0 || avail > 0) ok(`Gateway indexed — total=${total} available=${avail}  (poll #${n}, ${elapsed})`);
      else info(`poll #${String(n).padStart(2)}  [${elapsed} elapsed]  total=0 available=0  — waiting...`);
    });
  }

  const balAfter = await gw.getBalances();
  ok(`Gateway credited: ${balAfter?.gateway?.formattedTotal ?? "?"} USDC total, ${balAfter?.gateway?.formattedAvailable ?? "?"} available`);

  // ── Step 4: Payment ───────────────────────────────────────────────────────
  step(4, "x402 Payment");
  info(`URL     : ${SELLER_URL}`);
  console.log(`  [${ts()}] Signing EIP-3009 authorization (off-chain, zero gas)...`);
  const result = await gw.pay(SELLER_URL);
  ok(`Paid ${result.formattedAmount} USDC`);
  info(`Circle TX    : ${result.transaction}`);
  info(`Payer on-chain: ${session.burnerAddress}  ← burner, NOT real EOA ✓`);
  info(`Content      : ${String(JSON.stringify(result.data)).slice(0, 72)}...`);

  // ── Step 5: Teardown ──────────────────────────────────────────────────────
  step(5, "Teardown — return funds + destroy burner key");
  const balFinal  = await gw.getBalances();
  const remaining = balFinal?.gateway?.formattedAvailable ?? "0";

  // Subtract small buffer to avoid Gateway rounding-up errors
  const withdrawAmount = String(Math.floor((parseFloat(remaining) - 0.002) * 1000) / 1000);
  if (parseFloat(withdrawAmount) >= 0.1) {
    info(`Withdrawing ${withdrawAmount} USDC from Gateway → burner...`);
    await gw.withdraw(withdrawAmount);
    ok(`Gateway withdrawn`);
  } else {
    info(`Remaining ${remaining} USDC below Gateway min withdrawal (0.1) — left in Gateway`);
  }

  info(`Returning USDC to Unlink privacy pool (Permit2 + depositToPool)...`);
  await session.teardown();
  ok(`Burner key permanently destroyed — address ${session.burnerAddress} is now dead`);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("");
  console.log("  ══════════════════════════════════════════════════════════");
  if (isBaseSepolia) {
    console.log("  ✅  Flow complete (Base Sepolia)");
  } else {
    console.log("  ✅  Privacy mode: END-TO-END SUCCESS");
  }
  console.log(`  Burner  : ${session.burnerAddress} — used and destroyed`);
  console.log(`  Real EOA: ${realEoa.address}`);
  if (isBaseSepolia) {
    console.log(`  Privacy : FULL — real EOA never appeared on any payment chain`);
  } else {
    console.log(`  Privacy : PARTIAL (testnet) — Arc Testnet funding tx links real EOA → burner`);
    console.log(`  Mainnet : FULL — single Base chain, Unlink ZK pool shields everything`);
  }
  console.log("  ══════════════════════════════════════════════════════════");
  console.log("");
}

main().catch((err) => {
  console.error("\n  ✗ FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
