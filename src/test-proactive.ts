/**
 * Tests the proactive payment flow — single HTTP request, no 402 round-trip.
 *
 * Flow: parse robots.txt → sign EIP-3009 locally → send with Payment-Signature → get content
 *
 * Usage:
 *   NANOCRAWL_BUYER_PRIVATE_KEY=0x... npx tsx src/test-proactive.ts
 */

import { randomBytes } from "crypto";
// @ts-ignore
import { GatewayClient } from "@circle-fin/x402-batching/client";

const BUYER_KEY = process.env.NANOCRAWL_BUYER_PRIVATE_KEY!;
const TARGET = process.env.NANOCRAWL_TARGET ?? "https://nanocrawl.vercel.app";
const USDC_DECIMALS = 6;

const client = new GatewayClient({
  chain: "arcTestnet",
  privateKey: (BUYER_KEY.startsWith("0x") ? BUYER_KEY : `0x${BUYER_KEY}`) as `0x${string}`,
});

function parseRobotsTxt(text: string) {
  const get = (key: string) => text.match(new RegExp(`${key}:\\s*(.+)`, "i"))?.[1]?.trim();
  return {
    payTo: get("Payment-PayTo")!,
    network: get("Payment-Network")!,
    asset: get("Payment-Asset")!,
    verifyingContract: get("Payment-VerifyingContract")!,
    crawlFeeUsdc: parseFloat(get("Crawl-fee") ?? "0"),
    maxTimeoutSeconds: parseInt(get("Payment-MaxTimeoutSeconds") ?? "345600", 10),
  };
}

async function main() {
  console.log(`Address: ${client.address}`);
  console.log(`Target:  ${TARGET}\n`);

  // ── Step 1: Read robots.txt ────────────────────────────────────────────
  console.log("1. Reading robots.txt for payment metadata...");
  const robotsRes = await fetch(`${TARGET}/robots.txt`);
  const robotsTxt = await robotsRes.text();
  const meta = parseRobotsTxt(robotsTxt);
  console.log(`   PayTo: ${meta.payTo}`);
  console.log(`   Price: ${meta.crawlFeeUsdc} USDC`);
  console.log(`   Network: ${meta.network}`);

  // ── Step 2: Standard flow (2 requests) ───────────────��─────────────────
  console.log("\n2. STANDARD flow — browse /products/2 (402 → sign → retry)...");
  const t1 = Date.now();
  const standardResult = await client.pay(`${TARGET}/products/2`);
  const standardMs = Date.now() - t1;
  console.log(`   Status: ${standardResult.status}`);
  console.log(`   Paid: ${standardResult.formattedAmount} USDC`);
  console.log(`   Time: ${standardMs}ms (2 HTTP requests)`);

  // ── Step 3: Proactive flow (1 request) ─────────────────────────────────
  console.log("\n3. PROACTIVE flow — browse /products/3 (sign locally → single request)...");

  const amountUnits = Math.round(meta.crawlFeeUsdc * 10 ** USDC_DECIMALS).toString();
  const nonce = `0x${randomBytes(32).toString("hex")}` as `0x${string}`;
  const chainId = parseInt(meta.network.split(":")[1], 10);
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 5 * 24 * 60 * 60);

  // Sign EIP-3009 authorization locally
  const signature = await client.account.signTypedData({
    domain: {
      name: "GatewayWalletBatched",
      version: "1",
      chainId,
      verifyingContract: meta.verifyingContract as `0x${string}`,
    },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization" as const,
    message: {
      from: client.address,
      to: meta.payTo as `0x${string}`,
      value: BigInt(amountUnits),
      validAfter: 0n,
      validBefore,
      nonce,
    },
  });

  const paymentPayload = {
    x402Version: 2,
    resource: {
      url: `${TARGET}/products/3`,
      mimeType: "application/json",
      description: "NanoCrawl paid content",
    },
    accepted: {
      scheme: "exact",
      network: meta.network,
      asset: meta.asset,
      amount: amountUnits,
      payTo: meta.payTo,
      maxTimeoutSeconds: meta.maxTimeoutSeconds,
      extra: {
        name: "GatewayWalletBatched",
        version: "1",
        verifyingContract: meta.verifyingContract,
      },
    },
    payload: {
      signature,
      authorization: {
        from: client.address,
        to: meta.payTo,
        value: amountUnits,
        validAfter: "0",
        validBefore: validBefore.toString(),
        nonce,
      },
    },
  };

  const encoded = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");

  const t2 = Date.now();
  const proactiveRes = await fetch(`${TARGET}/products/3`, {
    headers: {
      "User-Agent": "NanoCrawl/1.0 (AI agent)",
      "X-NanoCrawl-Capable": "true",
      "Payment-Signature": encoded,
    },
  });
  const proactiveMs = Date.now() - t2;

  console.log(`   Status: ${proactiveRes.status}`);

  if (proactiveRes.status === 200) {
    const prHeader = proactiveRes.headers.get("payment-response");
    let tx = "?";
    if (prHeader) {
      try {
        const pr = JSON.parse(Buffer.from(prHeader, "base64").toString("utf-8"));
        tx = pr.transaction ?? "?";
      } catch {}
    }
    const data = await proactiveRes.json();
    console.log(`   Paid: ${meta.crawlFeeUsdc} USDC`);
    console.log(`   TX: ${tx}`);
    console.log(`   Time: ${proactiveMs}ms (1 HTTP request)`);
    console.log(`   Content: ${data.name ?? JSON.stringify(data).slice(0, 80)}`);
  } else {
    const body = await proactiveRes.text();
    console.log(`   FAILED: ${body.slice(0, 200)}`);
  }

  // ── Summary ────────────────────────────────────────────────────────────
  console.log("\n4. Comparison:");
  console.log(`   Standard:  ${standardMs}ms (2 HTTP requests — GET → 402 → sign → retry)`);
  console.log(`   Proactive: ${proactiveMs}ms (1 HTTP request — sign locally → send)`);
  if (proactiveRes.status === 200) {
    const savings = Math.round((1 - proactiveMs / standardMs) * 100);
    console.log(`   Savings:   ${savings > 0 ? savings + "%" : "N/A"} faster`);
    console.log("\n   At scale (100k pages): proactive saves 100,000 HTTP round-trips.");
  }
}

main().catch((err) => {
  console.error(`Failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
