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
  createUser,
  getUser,
  requestPrivateTokens,
} from "@unlink-xyz/sdk";
import {
  createWalletClient,
  createPublicClient,
  http,
  type Address,
} from "viem";
import { baseSepolia } from "viem/chains";
import { CapturingBurnerStorage, loadPersistedBurner } from "./storage.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Unlink faucet test token on Base Sepolia (18 decimals) */
const POOL_TOKEN = "0x7501de8ea37a21e20e6e65947d2ecab0e9f061a7" as const;
const POOL_TOKEN_DECIMALS = 18;

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

  // Ensure the Unlink account is registered (lazy registration)
  try {
    await getUser(unlinkClient, accountKeys.address);
    log(`user ${accountKeys.address.slice(0, 20)}... already registered`);
  } catch {
    log(`registering user ${accountKeys.address.slice(0, 20)}...`);
    await createUser(unlinkClient, accountKeys);
    log(`user registered`);
  }

  // Check for a burner persisted from a previous session (crash recovery).
  // If one exists and is still 'funded', restore it instead of draining the pool again.
  const storage = new CapturingBurnerStorage();
  let burner: BurnerWallet;

  const persisted = loadPersistedBurner();
  if (persisted) {
    log(`found persisted burner ${persisted.address} — checking status...`);
    // Hydrate storage so BurnerWallet.restore() can load the key
    await storage.save(persisted.address, persisted.privateKey);
    const restored = await BurnerWallet.restore(persisted.address as Address, storage);
    if (restored) {
      try {
        const status = await restored.getStatus(unlinkClient);
        if (status.status === "funded") {
          log(`restoring funded burner ${persisted.address} (skipping fundFromPool)`);
          burner = restored;
        } else {
          log(`persisted burner status=${status.status} — creating fresh burner`);
          await storage.delete(persisted.address); // clear stale file
          burner = await BurnerWallet.create(storage);
        }
      } catch (err) {
        log(`persisted burner lookup failed (${err instanceof Error ? err.message : err}) — creating fresh burner`);
        await storage.delete(persisted.address);
        burner = await BurnerWallet.create(storage);
      }
    } else {
      log(`could not restore burner — creating fresh burner`);
      burner = await BurnerWallet.create(storage);
    }
  } else {
    burner = await BurnerWallet.create(storage);
    log(`burner created: ${burner.address}`);
  }

  // Convert session amount to pool token base units
  const amountUnits = String(
    BigInt(Math.round(parseFloat(sessionAmountUsdc) * 10 ** POOL_TOKEN_DECIMALS))
  );

  // Fund burner only if it isn't already funded (fresh burner path)
  const currentStatus = await burner.getStatus(unlinkClient).catch(() => null);
  if (currentStatus?.status !== "funded") {
    log(`funding burner with ${sessionAmountUsdc} USDC from Unlink pool...`);
    try {
      await burner.fundFromPool(unlinkClient, {
        senderKeys: accountKeys,
        token: POOL_TOKEN,
        amount: amountUnits,
        environment: "base-sepolia",
      });
    } catch (err) {
      // If insufficient balance, try faucet then retry
      const isInsufficientBalance =
        (err instanceof UnlinkApiError && err.message.includes("insufficient balance")) ||
        (err instanceof Error && err.message.includes("insufficient balance"));
      if (isInsufficientBalance) {
        log(`insufficient pool balance — requesting faucet tokens...`);
        try {
          await requestPrivateTokens(unlinkClient, {
            token: POOL_TOKEN,
            unlinkAddress: accountKeys.address,
          });
          log(`faucet tokens requested — waiting 5s for settlement...`);
          await sleep(5_000);
        } catch (faucetErr) {
          log(`faucet request failed: ${faucetErr instanceof Error ? faucetErr.message : faucetErr}`);
          throw new Error(
            `Unlink pool has insufficient balance and faucet failed. ` +
            `Deposit USDC into your Unlink account or use the faucet at https://hackathon-apikey.vercel.app/faucet`
          );
        }
        // Retry fundFromPool after faucet
        log(`retrying fundFromPool after faucet...`);
        try {
          // Need a fresh burner since the old one may be in a bad state
          burner = await BurnerWallet.create(storage);
          log(`fresh burner created: ${burner.address}`);
          await burner.fundFromPool(unlinkClient, {
            senderKeys: accountKeys,
            token: POOL_TOKEN,
            amount: amountUnits,
            environment: "base-sepolia",
          });
        } catch (retryErr) {
          if (retryErr instanceof UnlinkApiError) {
            throw new Error(
              `Unlink API error during fundFromPool (after faucet): ${retryErr.message} (code: ${retryErr.code})`
            );
          }
          throw retryErr;
        }
      } else if (err instanceof UnlinkApiError) {
        throw new Error(
          `Unlink API error during fundFromPool: ${err.message} (code: ${err.code})`
        );
      } else {
        throw err;
      }
    }
    // Poll until status reaches 'funded' (USDC + gas ETH confirmed at burner)
    await pollUntilFunded(burner, unlinkClient);
  }

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

  // Read current pool token balance at burner
  const balance = (await publicClient.readContract({
    address: POOL_TOKEN,
    abi: erc20BalanceAbi,
    functionName: "balanceOf",
    args: [burnerAddress],
  })) as bigint;

  log(`teardown: burner pool token balance = ${balance} units (${Number(balance) / 10 ** POOL_TOKEN_DECIMALS} tokens)`);

  if (balance > 0n) {
    const walletClient = createWalletClient({
      account: burner.toViemAccount(),
      chain: baseSepolia,
      transport: http(rpcUrl),
    });

    // Approve the Permit2 contract to spend the burner's pool token
    log(`teardown: approving Permit2 for ${balance} units...`);
    const approveTxHash = await walletClient.writeContract({
      address: POOL_TOKEN,
      abi: erc20ApproveAbi,
      functionName: "approve",
      args: [info.permit2_address as Address, balance],
    });
    await publicClient.waitForTransactionReceipt({ hash: approveTxHash });
    log(`teardown: Permit2 approved (tx: ${approveTxHash})`);

    // Return USDC to the Unlink privacy pool
    log(`teardown: depositing ${balance} units back to pool...`);
    try {
      const result = await burner.depositToPool(unlinkClient, {
        unlinkAddress: accountKeys.address, // "unlink1..." bech32m
        token: POOL_TOKEN,
        amount: balance.toString(),
        environment: "base-sepolia",
        chainId: info.chain_id,
        permit2Address: info.permit2_address,
        poolAddress: info.pool_address,
        deadline: Math.floor(Date.now() / 1000) + 3600,
      });
      await burner.dispose(unlinkClient, result.txId);
    } catch (err) {
      // Known canary SDK bug: depositToPool fails with nonce error on some accounts.
      // USDC remains at burner address on-chain — not returned to pool.
      // We still destroy the key so the burner is abandoned (not reusable).
      log(`teardown: depositToPool failed (Unlink SDK bug) — ${err instanceof Error ? err.message : err}`);
      log(`teardown: ${balance} units (~${Number(balance) / 10 ** POOL_TOKEN_DECIMALS} tokens) left at burner, key will be destroyed`);
      await burner.dispose(unlinkClient).catch(() => {});
    }
  } else {
    log("teardown: no pool tokens to return, disposing burner");
    await burner.dispose(unlinkClient).catch(() => {});
  }

  await burner.deleteKey();
  log("teardown complete — burner key destroyed");
}

/**
 * Poll a GatewayClient until its balance exceeds zero.
 * Circle Gateway processes on-chain deposit events asynchronously —
 * the balance is not credited immediately after the deposit tx confirms.
 * We check formattedTotal (reflects deposit sooner than formattedAvailable).
 */
export async function pollUntilGatewayFunded(
  gatewayClient: { getBalances(): Promise<{ gateway?: { formattedAvailable?: string; formattedTotal?: string } }> },
  timeoutMs = 180_000,
  intervalMs = 5_000,
  onPoll?: (attempt: number, elapsed: string, total: number, available: number) => void
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    const b = await gatewayClient.getBalances();
    const total     = parseFloat(b?.gateway?.formattedTotal     ?? "0");
    const available = parseFloat(b?.gateway?.formattedAvailable ?? "0");
    attempt++;
    const elapsed = `${(attempt * intervalMs / 1000).toFixed(0)}s`;
    if (total > 0 || available > 0) {
      if (onPoll) onPoll(attempt, elapsed, total, available);
      else log(`Gateway indexed ✓  total=${total} available=${available}  (poll #${attempt}, ${elapsed})`);
      return;
    }
    if (onPoll) onPoll(attempt, elapsed, total, available);
    else log(`Gateway poll #${String(attempt).padStart(2)}  [${elapsed} elapsed]  total=0 available=0  — waiting...`);
    await sleep(intervalMs);
  }
  throw new Error(
    `Timeout (${timeoutMs / 1000}s, ${attempt} polls) — Circle Gateway did not credit deposit.\n` +
    `    Deposit is on-chain but indexer is not watching this chain.\n` +
    `    Run test:unlink (Arc Testnet) as workaround.`
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(msg: string): void {
  process.stderr.write(`[nanocrawl:unlink] ${msg}\n`);
}
