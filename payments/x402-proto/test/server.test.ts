// x402 sunucusunun ağ gerektirmeyen testleri: sahte facilitator ile 402 yanıtı ve geçersiz ödeme.
// Gerçek Devnet ödemesi elle yapılır (README, "Devnet'te çalıştırma").
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { createApp } from "../src/server.ts";
import { CLIENT_MAX_ATOMIC, DEVNET_USDC_MINT, SOLANA_DEVNET, devnetPolicy } from "../src/config.ts";

const PAY_TO = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const FEE_PAYER = "2wmVCSfPxGPjrnMMn7rchp4uaeoTqN39mXFC2zhPdri9";
let facilitator: Server, app: Server, base: string;
const calls: string[] = [];

const listen = (s: Server) => new Promise<string>((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));

before(async () => {
  facilitator = createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    res.setHeader("content-type", "application/json");
    if (req.url === "/supported") {
      return res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: SOLANA_DEVNET, extra: { feePayer: FEE_PAYER } }], extensions: [], signers: {} }));
    }
    if (req.url === "/verify") return res.end(JSON.stringify({ isValid: false, invalidReason: "invalid_exact_svm_payload_transaction" }));
    res.statusCode = 400;
    res.end(JSON.stringify({ success: false, errorReason: "unexpected" }));
  });
  const fUrl = await listen(facilitator);
  app = createServer(createApp({ payTo: PAY_TO, facilitatorUrl: fUrl }));
  base = await listen(app);
});
after(() => {
  app.close();
  facilitator.close();
});

test("ödemesiz /health 200 döner", async () => {
  assert.equal((await fetch(`${base}/health`)).status, 200);
});

test("ödemesiz /demo → 402 ve PAYMENT-REQUIRED: Devnet, USDC, 0,01 USDC, doğru alıcı", async () => {
  const res = await fetch(`${base}/demo`);
  assert.equal(res.status, 402);
  const header = res.headers.get("PAYMENT-REQUIRED");
  assert.ok(header, "PAYMENT-REQUIRED başlığı olmalı");
  const pr = decodePaymentRequiredHeader(header);
  assert.equal(pr.x402Version, 2);
  const [req] = pr.accepts;
  assert.equal(req.scheme, "exact");
  assert.equal(req.network, SOLANA_DEVNET);
  assert.equal(req.asset, DEVNET_USDC_MINT);
  assert.equal(req.amount, "10000");
  assert.equal(req.payTo, PAY_TO);
  assert.equal((req.extra as { feePayer?: string }).feePayer, FEE_PAYER, "işlem ücretini facilitator öder");
  assert.ok(calls.includes("GET /supported"));
});

test("geçersiz PAYMENT-SIGNATURE ile kaynak verilmez", async () => {
  const garbage = Buffer.from(JSON.stringify({ x402Version: 2, payload: { transaction: "AAAA" } })).toString("base64");
  const res = await fetch(`${base}/demo`, { headers: { "PAYMENT-SIGNATURE": garbage } });
  assert.notEqual(res.status, 200);
  assert.doesNotMatch(await res.text(), /Ödeme alındı/);
});

test("istemci politikası: yalnızca Devnet + Devnet USDC + üst sınır", () => {
  const ok = { network: SOLANA_DEVNET, asset: DEVNET_USDC_MINT, amount: String(CLIENT_MAX_ATOMIC) };
  assert.deepEqual(devnetPolicy(2, [ok]), [ok]);
  assert.deepEqual(devnetPolicy(2, [{ ...ok, network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }]), [], "mainnet reddedilmeli");
  assert.deepEqual(devnetPolicy(2, [{ ...ok, asset: "So11111111111111111111111111111111111111112" }]), [], "başka token reddedilmeli");
  assert.deepEqual(devnetPolicy(2, [{ ...ok, amount: String(CLIENT_MAX_ATOMIC + 1n) }]), [], "üst sınır aşılmamalı");
});
