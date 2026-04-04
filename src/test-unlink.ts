#!/usr/bin/env tsx
/**
 * Integration test for Unlink privacy mode (Option C: Arc Testnet payments).
 *
 * Flow:
 *   1. startBurnerSession() — create burner on Base Sepolia, fund from Unlink ZK pool
 *   2. Transfer Arc Testnet USDC from real EOA → burner (Arc Testnet transfer)
 *   3. GatewayClient with burner key on arcTestnet — deposit, pay one page
 *   4. close_session equivalent — Gateway withdraw, teardown (depositToPool + dispose + deleteKey)
 *
 * Privacy: Unlink creates and funds the burner via ZK-shielded pool on Base Sepolia.
 * Caveat (testnet): the Arc Testnet funding tx links real EOA → burner.
 *   On mainnet both chains would be Base, so this link would not exist.
 *
 * Run:
 *   NANOCRAWL_UNLINK_MNEMONIC="..." NANOCRAWL_UNLINK_API_KEY="..." npm run test:unlink
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

// ── Arc Testnet USDC (ERC-20, 6 decimals) ────────────────────────────────────
const ARC_USDC = "0x3600000000000000000000000000000000000000" as const;
const ARC_RPC = "https://rpc.testnet.arc.network";

const SELLER_URL = "https://nanocrawl.vercel.app/products/1";
const SESSION_AMOUNT = process.env.NANOCRAWL_UNLINK_SESSION_AMOUNT ?? "0.1";

const erc20TransferAbi = [
  {
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "transfer",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

const erc20BalanceAbi = [
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] ${msg}`);
}

/** Load real EOA private key from env or ~/.nanocrawl/wallet.json */
function getRealEoaPrivateKey(): `0x${string}` {
  const envKey = process.env.NANOCRAWL_BUYER_PRIVATE_KEY;
  if (envKey) {
    return (envKey.startsWith("0x") ? envKey : `0x${envKey}`) as `0x${string}`;
  }
  const walletPath = join(homedir(), ".nanocrawl", "wallet.json");
  if (existsSync(walletPath)) {
    try {
      const data = JSON.parse(readFileSync(walletPath, "utf-8"));
      if (data.privateKey) return data.privateKey as `0x${string}`;
    } catch { /* fall through */ }
  }
  throw new Error(
    "Real EOA private key not found. Set NANOCRAWL_BUYER_PRIVATE_KEY or run the MCP server once to generate ~/.nanocrawl/wallet.json"
  );
}

/**
 * Transfer Arc Testnet USDC from real EOA to burner address.
 * Arc Testnet native gas is USDC — no ETH needed.
 */
async function fundBurnerOnArc(
  realEoaPrivateKey: `0x${string}`,
  burnerAddress: Address,
  amountUsdc: string
): Promise<void> {
  const account = privateKeyToAccount(realEoaPrivateKey);
  const publicClient = createPublicClient({
    chain: arcTestnet,
    transport: http(ARC_RPC),
  });
  const walletClient = createWalletClient({
    account,
    chain: arcTestnet,
    transport: http(ARC_RPC),
  });

  // Check real EOA balance
  const balance = (await publicClient.readContract({
    address: ARC_USDC,
    abi: erc20BalanceAbi,
    functionName: "balanceOf",
    args: [account.address],
  })) as bigint;

  const amountUnits = parseUnits(amountUsdc, 6);
  const formattedBalance = Number(balance) / 1e6;
  log(`  Real EOA Arc Testnet USDC: ${formattedBalance.toFixed(6)}`);

  if (balance < amountUnits) {
    throw new Error(
      `Insufficient Arc Testnet USDC on real EOA (${account.address}). ` +
      `Have: ${formattedBalance.toFixed(6)}, Need: ${amountUsdc}. ` +
      `Get more at https://faucet.circle.com (select Arc Testnet).`
    );
  }

  log(`  Transferring ${amountUsdc} USDC to burner on Arc Testnet...`);
  const txHash = await walletClient.writeContract({
    address: ARC_USDC,
    abi: erc20TransferAbi,
    functionName: "transfer",
    args: [burnerAddress, amountUnits],
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });
  log(`  Transfer tx: ${txHash}`);
}

async function main() {
  const mnemonic = process.env.NANOCRAWL_UNLINK_MNEMONIC;
  const apiKey = process.env.NANOCRAWL_UNLINK_API_KEY;

  if (!mnemonic || !apiKey) {
    console.error("Set NANOCRAWL_UNLINK_MNEMONIC and NANOCRAWL_UNLINK_API_KEY");
    process.exit(1);
  }

  console.log("");
  console.log("  NanoCrawl × Unlink — privacy mode integration test (Option C)");
  console.log("  ──────────────────────────────────────────────────────────────");
  console.log("  Unlink: burner created on Base Sepolia (ZK-shielded)");
  console.log("  Payments: Arc Testnet (Circle Gateway proven to work)");
  console.log("");

  // ── Step 1: Start Unlink session (Base Sepolia ZK burner) ─────────────────
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
  log(`  (on Base Sepolia: this address, NOT your real EOA, is visible)`);
  console.log("");

  // ── Step 2: Fund burner with Arc Testnet USDC from real EOA ──────────────
  log("Funding burner with Arc Testnet USDC from real EOA...");
  log("(testnet caveat: this tx links real EOA → burner on Arc Testnet)");
  log("(on mainnet both chains = Base, so no such link would exist)");

  const realEoaKey = getRealEoaPrivateKey();
  const realEoa = privateKeyToAccount(realEoaKey);
  log(`  Real EOA: ${realEoa.address}`);

  await fundBurnerOnArc(realEoaKey, session.burnerAddress, SESSION_AMOUNT);
  log(`✓ Burner funded on Arc Testnet`);
  console.log("");

  // ── Step 3: GatewayClient with burner key on Arc Testnet ─────────────────
  log("Creating GatewayClient with burner key (Arc Testnet)...");
  const gw = new GatewayClient({
    chain: "arcTestnet",
    privateKey: session.burnerPrivateKey,
  });

  log(`  Gateway address: ${gw.address}`);

  const balBefore = await gw.getBalances();
  log(`  Wallet USDC:  ${balBefore?.wallet?.formatted ?? "?"}`);
  log(`  Gateway USDC: ${balBefore?.gateway?.formattedAvailable ?? "?"}`);
  console.log("");

  // ── Step 4: Deposit into Gateway ─────────────────────────────────────────
  const walletUsdc = parseFloat(balBefore?.wallet?.formatted ?? "0");
  const gatewayTotal = parseFloat(balBefore?.gateway?.formattedTotal ?? "0");

  if (gatewayTotal > 0) {
    log(`Gateway already funded (total=${gatewayTotal}) — skipping deposit`);
  } else if (walletUsdc > 0) {
    log(`Depositing ${SESSION_AMOUNT} USDC into Gateway from burner...`);
    const depositResult = await gw.deposit(SESSION_AMOUNT);
    log(`  Deposit tx: ${depositResult?.depositTxHash ?? "unknown"}`);
    log("  Waiting for Circle Gateway to index deposit...");
    await pollUntilGatewayFunded(gw, 180_000);
  } else {
    log("Wallet empty + Gateway empty — previous deposit is on-chain but not yet indexed.");
    log("Waiting for Circle Gateway to process it...");
    await pollUntilGatewayFunded(gw, 180_000);
  }

  const balAfter = await gw.getBalances();
  log(`✓ Gateway balance: total=${balAfter?.gateway?.formattedTotal ?? "?"} available=${balAfter?.gateway?.formattedAvailable ?? "?"} USDC`);
  console.log("");

  // ── Step 5: Browse one page (the actual payment) ─────────────────────────
  log(`Browsing: ${SELLER_URL}`);
  const result = await gw.pay(SELLER_URL);
  log(`✓ Paid ${result.formattedAmount} USDC — TX: ${result.transaction}`);
  log(`  Content preview: ${String(JSON.stringify(result.data)).slice(0, 80)}...`);
  console.log("");

  // ── Step 6: Teardown ──────────────────────────────────────────────────────
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
  console.log("  ──────────────────────────────────────────────────────────────");
  console.log(`  ✅  Privacy mode working end-to-end (Option C)`);
  console.log(`  Burner ${session.burnerAddress} was used and disposed.`);
  console.log(`  Real EOA ${realEoa.address} never appeared on-chain for payments.`);
  console.log(`  (Arc Testnet funding tx links real EOA → burner — testnet caveat only)`);
  console.log("");
}

main().catch((err) => {
  console.error("FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
