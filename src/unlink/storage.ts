/**
 * CapturingBurnerStorage
 *
 * Implements the BurnerStorage interface and intercepts the private key when
 * BurnerWallet.create() stores it. BurnerWallet does not expose the private key
 * directly — it lives in the pluggable storage. By providing this custom storage
 * we capture the key at save() time, making it available for use with external
 * clients (e.g. Circle GatewayClient) that require a raw private key.
 */
export class CapturingBurnerStorage {
  private readonly keys = new Map<string, string>();
  private _capturedKey: string | null = null;

  async save(address: string, privateKey: string): Promise<void> {
    this.keys.set(address.toLowerCase(), privateKey);
    this._capturedKey = privateKey;
  }

  async load(address: string): Promise<string | null> {
    return this.keys.get(address.toLowerCase()) ?? null;
  }

  async delete(address: string): Promise<void> {
    this.keys.delete(address.toLowerCase());
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
