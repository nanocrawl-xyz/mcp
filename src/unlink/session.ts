/**
 * Unlink BurnerWallet session — full lifecycle management.
 *
 * Per-session flow:
 *   1. Create ephemeral burner EOA (private key captured via CapturingBurnerStorage)
 *   2. Fund burner from Unlink privacy pool (ZK-shielded; relayer tops up gas ETH)
 *   3. Poll until status = 'funded'
 *   4. Return burnerPrivateKey → caller creates GatewayClient({ chain: 'baseSepolia', privateKey })
 *   5. On teardown (after caller calls gateway.withdraw()):
 *        read USDC balance → Permit2 approve → depositToPool → dispose → deleteKey
 *
 * Privacy guarantee: on-chain, only the ephemeral burner address is visible.
 * The link between the burner and the real agent identity is shielded by
 * Unlink's ZK privacy pool. Each session uses a fresh burner — no continuity.
 */

import {
  createUnlinkClient,
  unlinkAccount,
  BurnerWallet,
  UnlinkApiError,
} from "@unlink-xyz/sdk";
import {
  createWalletClient,
  createPublicClient,
  http,
  type Address,
} from "viem";
import { baseSepolia } from "viem/chains";
import { CapturingBurnerStorage } from "./storage.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Circle's official USDC on Base Sepolia */
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;

const DEFAULT_ENGINE_URL = "https://staging-api.unlink.xyz";
const DEFAULT_RPC_URL = "https://sepolia.base.org";

const erc20ApproveAbi = [
  {
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "approve",
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

// ── Public types ───────────────────────────────────────────────────────────────

export interface UnlinkConfig {
  /** BIP-39 mnemonic for the Unlink account (must have USDC deposited in pool). */
  mnemonic: string;
  /** API key from https://hackaton-apikey.vercel.app */
  apiKey: string;
  /** USDC to fund the burner per session (e.g. '5' for 5 USDC). Default: '5'. */
  sessionAmountUsdc?: string;
  /** Unlink engine URL. Default: https://staging-api.unlink.xyz */
  engineUrl?: string;
  /** Base Sepolia RPC URL. Default: https://sepolia.base.org */
  rpcUrl?: string;
}

export interface BurnerSession {
  /** Ephemeral burner EOA address (disposable — abandoned after session). */
  burnerAddress: Address;
  /**
   * Raw private key for the burner. Use with Circle GatewayClient:
   *   new GatewayClient({ chain: 'baseSepolia', privateKey: burnerPrivateKey })
   */
  burnerPrivateKey: `0x${string}`;
  /**
   * Tear down the session. Call AFTER gateway.withdraw() so the USDC is back
   * at the burner EOA. This will:
   *   1. Read USDC balance at burner
   *   2. Approve Permit2 for the balance
   *   3. depositToPool → return USDC to Unlink privacy pool
   *   4. dispose → mark burner as done on Unlink API
   *   5. deleteKey → permanently destroy the private key
   */
  teardown(): Promise<void>;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Start a new Unlink privacy session.
 *
 * Creates a fresh burner EOA, funds it from the Unlink privacy pool, and waits
 * until USDC + gas ETH are confirmed at the burner. Returns the session with the
 * burner's private key ready for use with Circle GatewayClient on Base Sepolia.
 *
 * @throws UnlinkApiError if the pool API rejects (e.g. insufficient balance)
 * @throws Error if gas funding fails or times out (default 120s)
 */
export async function startBurnerSession(
  config: UnlinkConfig
): Promise<BurnerSession> {
  const engineUrl = config.engineUrl ?? DEFAULT_ENGINE_URL;
  const rpcUrl = config.rpcUrl ?? DEFAULT_RPC_URL;
  const sessionAmountUsdc = config.sessionAmountUsdc ?? "5";

  // Low-level Unlink client — stateless, handles all BurnerWallet API calls
  const unlinkClient = createUnlinkClient(engineUrl, config.apiKey);

  // Derive EdDSA signing keys from mnemonic (proves pool ownership in fundFromPool)
  const account = unlinkAccount.fromMnemonic({ mnemonic: config.mnemonic });
  const accountKeys = await account.getAccountKeys();

  // Create burner. CapturingBurnerStorage intercepts save() to get the private key,
  // since BurnerWallet does not expose it via any public property or method.
  const storage = new CapturingBurnerStorage();
  const burner = await BurnerWallet.create(storage);

  log(`burner created: ${burner.address}`);

  // Convert sessionAmountUsdc to USDC base units (6 decimals)
  const amountUnits = String(
    Math.round(parseFloat(sessionAmountUsdc) * 1_000_000)
  );

  // Fund burner from Unlink privacy pool.
  // The Unlink relayer performs a ZK-shielded withdrawal → USDC arrives at burner.
  // Relayer also sends gas ETH to cover the burner's on-chain transactions.
  log(`funding burner with ${sessionAmountUsdc} USDC from Unlink pool...`);
  try {
    await burner.fundFromPool(unlinkClient, {
      senderKeys: accountKeys,
      token: USDC,
      amount: amountUnits,
      environment: "base-sepolia",
    });
  } catch (err) {
    if (err instanceof UnlinkApiError) {
      throw new Error(
        `Unlink API error during fundFromPool: ${err.message} (code: ${err.code})`
      );
    }
    throw err;
  }

  // Poll until status reaches 'funded' (USDC + gas ETH confirmed at burner)
  await pollUntilFunded(burner, unlinkClient);
  log(`burner ${burner.address} funded and ready`);

  const burnerPrivateKey = storage.privateKey;

  return {
    burnerAddress: burner.address as Address,
    burnerPrivateKey,
    teardown: () => teardownSession(burner, unlinkClient, accountKeys, rpcUrl),
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function pollUntilFunded(
  burner: BurnerWallet,
  client: ReturnType<typeof createUnlinkClient>,
  timeoutMs = 120_000,
  intervalMs = 3_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await burner.getStatus(client);
    if (status.status === "funded") return;
    if (status.status === "gas_funding_failed") {
      throw new Error(
        `Unlink: gas funding failed for burner ${burner.address}`
      );
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `Unlink: timeout (${timeoutMs / 1000}s) waiting for burner ${burner.address} to reach 'funded' status`
  );
}

async function teardownSession(
  burner: BurnerWallet,
  unlinkClient: ReturnType<typeof createUnlinkClient>,
  accountKeys: Awaited<
    ReturnType<
      ReturnType<typeof unlinkAccount.fromMnemonic>["getAccountKeys"]
    >
  >,
  rpcUrl: string
): Promise<void> {
  // Fetch pool config: permit2_address, pool_address, chain_id
  const info = await BurnerWallet.getInfo(unlinkClient);
  const burnerAddress = burner.address as Address;

  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(rpcUrl),
  });

  // Read current USDC balance at burner (should be the Gateway-withdrawn amount)
  const balance = (await publicClient.readContract({
    address: USDC,
    abi: erc20BalanceAbi,
    functionName: "balanceOf",
    args: [burnerAddress],
  })) as bigint;

  log(`teardown: burner USDC balance = ${balance} units (${Number(balance) / 1e6} USDC)`);

  if (balance > 0n) {
    const walletClient = createWalletClient({
      account: burner.toViemAccount(),
      chain: baseSepolia,
      transport: http(rpcUrl),
    });

    // Approve the Permit2 contract to spend the burner's USDC
    log(`teardown: approving Permit2 for ${balance} units...`);
    const approveTxHash = await walletClient.writeContract({
      address: USDC,
      abi: erc20ApproveAbi,
      functionName: "approve",
      args: [info.permit2_address as Address, balance],
    });
    await publicClient.waitForTransactionReceipt({ hash: approveTxHash });
    log(`teardown: Permit2 approved (tx: ${approveTxHash})`);

    // Return USDC to the Unlink privacy pool
    log(`teardown: depositing ${balance} units back to pool...`);
    const result = await burner.depositToPool(unlinkClient, {
      unlinkAddress: accountKeys.address, // "unlink1..." bech32m
      token: USDC,
      amount: balance.toString(),
      environment: "base-sepolia",
      chainId: info.chain_id,
      permit2Address: info.permit2_address,
      poolAddress: info.pool_address,
      deadline: Math.floor(Date.now() / 1000) + 3600,
    });

    await burner.dispose(unlinkClient, result.txId);
  } else {
    log("teardown: no USDC to return, disposing burner");
    await burner.dispose(unlinkClient);
  }

  await burner.deleteKey();
  log("teardown complete — burner key destroyed");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(msg: string): void {
  process.stderr.write(`[nanocrawl:unlink] ${msg}\n`);
}
