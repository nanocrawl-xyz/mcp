import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const BURNER_DIR = join(homedir(), ".nanocrawl");
const BURNER_PATH = join(BURNER_DIR, "active-burner.json");

/**
 * CapturingBurnerStorage
 *
 * Implements BurnerStorage and intercepts the private key when
 * BurnerWallet.create() stores it. BurnerWallet has no .privateKey property —
 * the key lives only in the pluggable storage.
 *
 * This implementation persists the key to ~/.nanocrawl/active-burner.json so
 * it survives process crashes. On startup, call loadPersistedBurner() to
 * check if a funded burner from a previous session can be restored.
 */
export class CapturingBurnerStorage {
  private readonly keys = new Map<string, string>();
  private _capturedKey: string | null = null;

  async save(address: string, privateKey: string): Promise<void> {
    this.keys.set(address.toLowerCase(), privateKey);
    this._capturedKey = privateKey;

    // Persist to disk so the key survives process crashes
    mkdirSync(BURNER_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(
      BURNER_PATH,
      JSON.stringify({ address, privateKey }, null, 2),
      { mode: 0o600 }
    );
  }

  async load(address: string): Promise<string | null> {
    return this.keys.get(address.toLowerCase()) ?? null;
  }

  async delete(address: string): Promise<void> {
    this.keys.delete(address.toLowerCase());
    // Remove persisted file on clean teardown
    if (existsSync(BURNER_PATH)) {
      unlinkSync(BURNER_PATH);
    }
  }

  /** The burner's raw private key — available after BurnerWallet.create(this). */
  get privateKey(): `0x${string}` {
    if (!this._capturedKey) {
      throw new Error(
        "No burner key captured yet — call BurnerWallet.create(storage) first"
      );
    }
    const k = this._capturedKey;
    return (k.startsWith("0x") ? k : `0x${k}`) as `0x${string}`;
  }
}

/**
 * Load a burner that was persisted from a previous session.
 * Returns { address, privateKey } if a persisted burner exists, null otherwise.
 * The caller should check its status with burner.getStatus() and skip
 * creating a new burner if it is still in 'funded' state.
 */
export function loadPersistedBurner(): { address: string; privateKey: `0x${string}` } | null {
  if (!existsSync(BURNER_PATH)) return null;
  try {
    const data = JSON.parse(readFileSync(BURNER_PATH, "utf-8"));
    if (!data.address || !data.privateKey) return null;
    const pk = data.privateKey as string;
    return {
      address: data.address,
      privateKey: (pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`,
    };
  } catch {
    return null;
  }
}
