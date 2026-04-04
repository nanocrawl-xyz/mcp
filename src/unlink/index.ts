/**
 * @nanocrawl/unlink
 *
 * Unlink BurnerWallet session management for private agentic nanopayments.
 * Structured as a standalone module ready to publish as an npm package.
 *
 * Usage:
 *   import { startBurnerSession } from './unlink/index.js';
 *
 *   const session = await startBurnerSession({ mnemonic, apiKey });
 *   const gw = new GatewayClient({ chain: 'baseSepolia', privateKey: session.burnerPrivateKey });
 *   await gw.deposit('5.00');
 *   // ... crawl & pay loop ...
 *   await gw.withdraw(formattedAvailable);
 *   await session.teardown();
 */
export { startBurnerSession, pollUntilGatewayFunded } from "./session.js";
export type { BurnerSession, UnlinkConfig } from "./session.js";
