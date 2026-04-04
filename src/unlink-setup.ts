#!/usr/bin/env tsx
/**
 * NanoCrawl × Unlink — one-time setup script
 *
 * Deposits Circle USDC from your real agent EOA into the Unlink privacy pool
 * on Base Sepolia. Run this once before starting the MCP server in privacy mode.
 *
 * What this does:
 *   1. Check real EOA USDC balance on Base Sepolia
 *   2. Approve Permit2 to spend your USDC (one-time on-chain tx, ~0.00001 ETH gas)
 *   3. Deposit USDC into Unlink privacy pool (on-chain tx)
 *   4. Display your Unlink account address and shielded balance
 *
 * Prerequisites:
 *   - NANOCRAWL_UNLINK_MNEMONIC   — BIP-39 mnemonic for your Unlink account
 *   - NANOCRAWL_UNLINK_API_KEY    — from https://hackaton-apikey.vercel.app
 *   - Real EOA private key: NANOCRAWL_BUYER_PRIVATE_KEY or ~/.nanocrawl/wallet.json
 *   - Circle USDC on Base Sepolia: https://faucet.circle.com (select Base Sepolia)
 *   - Small ETH on Base Sepolia for gas: https://www.alchemy.com/faucets/base-sepolia
 *
 * Run:
 *   tsx src/unlink-setup.ts
 *   tsx src/unlink-setup.ts --amount 10   (deposit 10 USDC, default: 5)
 *   tsx src/unlink-setup.ts --check       (check balances only, no deposit)
 */

import { createUnlink, unlinkAccount, unlinkEvm } from "@unlink-xyz/sdk";
import { createWalletClient, createPublicClient, http, type Address } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ── Config ────────────────────────────────────────────────────────────────────

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
const DEFAULT_DEPOSIT_USDC = "5";
const RPC_URL = process.env.RPC_URL ?? "https://sepolia.base.org";

const erc20BalanceAbi = [
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// ── Wallet loading (mirrors index.ts logic) ───────────────────────────────────

function loadWalletKey(): `0x${string}` {
  const envKey = process.env.NANOCRAWL_BUYER_PRIVATE_KEY;
  if (envKey) return (envKey.startsWith("0x") ? envKey : `0x${envKey}`) as `0x${string}`;

  const walletPath = join(homedir(), ".nanocrawl", "wallet.json");
  if (existsSync(walletPath)) {
    const data = JSON.parse(readFileSync(walletPath, "utf-8"));
    if (data.privateKey) return data.privateKey as `0x${string}`;
  }

  throw new Error(
    "No EOA private key found. Set NANOCRAWL_BUYER_PRIVATE_KEY or run `npm run dev` once to auto-generate a wallet."
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check");
  const amountIdx = args.indexOf("--amount");
  const depositAmountUsdc = amountIdx !== -1 ? args[amountIdx + 1] : DEFAULT_DEPOSIT_USDC;
  const depositUnits = BigInt(Math.round(parseFloat(depositAmountUsdc) * 1_000_000));

  // ── Validate env ────────────────────────────────────────────────────────────
  const mnemonic = process.env.NANOCRAWL_UNLINK_MNEMONIC;
  const apiKey = process.env.NANOCRAWL_UNLINK_API_KEY;

  if (!mnemonic) {
    console.error("❌  NANOCRAWL_UNLINK_MNEMONIC is not set.");
    process.exit(1);
  }
  if (!apiKey) {
    console.error("❌  NANOCRAWL_UNLINK_API_KEY is not set.");
    process.exit(1);
  }

  // ── Build clients ───────────────────────────────────────────────────────────
  const privateKey = loadWalletKey();
  const evmAccount = privateKeyToAccount(privateKey);

  const walletClient = createWalletClient({
    account: evmAccount,
    chain: baseSepolia,
    transport: http(RPC_URL),
  });

  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(RPC_URL),
  });

  const unlink = createUnlink({
    engineUrl: process.env.NANOCRAWL_UNLINK_ENGINE_URL ?? "https://staging-api.unlink.xyz",
    apiKey,
    account: unlinkAccount.fromMnemonic({ mnemonic }),
    evm: unlinkEvm.fromViem({ walletClient, publicClient }),
  });

  // ── Balance check ───────────────────────────────────────────────────────────
  const usdcBalance = (await publicClient.readContract({
    address: USDC,
    abi: erc20BalanceAbi,
    functionName: "balanceOf",
    args: [evmAccount.address as Address],
  })) as bigint;

  const ethBalance = await publicClient.getBalance({ address: evmAccount.address as Address });
  const unlinkAddress = await unlink.getAddress();

  let poolBalance = "0";
  try {
    const { balances } = await unlink.getBalances();
    const tokenBalance = balances.find((b: { token: string }) => b.token.toLowerCase() === USDC.toLowerCase());
    poolBalance = tokenBalance ? String(Number(tokenBalance.amount) / 1e6) : "0";
  } catch {
    poolBalance = "(could not fetch)";
  }

  console.log("");
  console.log("  NanoCrawl × Unlink Setup");
  console.log("  ─────────────────────────────────────────");
  console.log(`  Real EOA:          ${evmAccount.address}`);
  console.log(`  Unlink account:    ${unlinkAddress}`);
  console.log(`  Network:           Base Sepolia`);
  console.log("");
  console.log(`  USDC (on-chain):   ${Number(usdcBalance) / 1e6} USDC`);
  console.log(`  ETH (gas):         ${Number(ethBalance) / 1e18} ETH`);
  console.log(`  USDC (in pool):    ${poolBalance} USDC`);
  console.log("");

  if (usdcBalance === 0n) {
    console.log("  ⚠️  No USDC on Base Sepolia.");
    console.log("  Get some: https://faucet.circle.com  (select Base Sepolia)");
  }
  if (ethBalance < 5_000_000_000_000n) { // < 0.000005 ETH
    console.log("  ⚠️  ETH balance very low — may not cover gas.");
    console.log("  Get some: https://www.alchemy.com/faucets/base-sepolia");
  }

  if (checkOnly) {
    console.log("  (--check mode: no deposit performed)");
    console.log("");
    return;
  }

  // ── Deposit ─────────────────────────────────────────────────────────────────
  if (usdcBalance < depositUnits) {
    console.error(
      `  ❌  Insufficient USDC: have ${Number(usdcBalance) / 1e6}, need ${depositAmountUsdc}.`
    );
    console.error("  Get USDC: https://faucet.circle.com  (select Base Sepolia)");
    process.exit(1);
  }

  console.log(`  Depositing ${depositAmountUsdc} USDC into Unlink pool...`);
  console.log("");

  // Step 1: Permit2 approval (one-time per token; SDK skips if already approved)
  console.log("  [1/2] Approving Permit2...");
  const approval = await unlink.ensureErc20Approval({
    token: USDC,
    amount: depositUnits.toString(),
  });

  if (approval.status === "submitted") {
    console.log(`        Approval tx: ${approval.txHash}`);
    console.log("        Waiting for confirmation...");
    await publicClient.waitForTransactionReceipt({
      hash: approval.txHash as `0x${string}`,
    });
    console.log("        ✓ Approved");
  } else {
    console.log("        ✓ Already approved (skipped)");
  }

  // Step 2: Deposit into pool
  console.log(`  [2/2] Depositing ${depositAmountUsdc} USDC into pool...`);
  const deposit = await unlink.deposit({
    token: USDC,
    amount: depositUnits.toString(),
  });

  console.log(`        Deposit txId: ${deposit.txId}`);
  console.log("        Waiting for confirmation...");

  const confirmed = await unlink.pollTransactionStatus(deposit.txId);
  console.log(`        ✓ Confirmed (status: ${confirmed.status})`);

  // ── Final balance ───────────────────────────────────────────────────────────
  let newPoolBalance = "?";
  try {
    const { balances } = await unlink.getBalances({ token: USDC });
    const tokenBalance = balances.find((b: { token: string }) => b.token.toLowerCase() === USDC.toLowerCase());
    newPoolBalance = tokenBalance ? String(Number(tokenBalance.amount) / 1e6) : "0";
  } catch { /* ignore */ }

  console.log("");
  console.log("  ─────────────────────────────────────────");
  console.log(`  ✅  Pool balance: ${newPoolBalance} USDC`);
  console.log("");
  console.log("  Privacy mode is ready. Start the MCP server with:");
  console.log("    NANOCRAWL_UNLINK_MNEMONIC='...' \\");
  console.log("    NANOCRAWL_UNLINK_API_KEY='...' \\");
  console.log("    npm run dev");
  console.log("");
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
