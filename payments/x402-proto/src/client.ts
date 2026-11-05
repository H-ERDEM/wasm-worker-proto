// Alıcı istemci: 402'yi yakalar, Devnet USDC ödemesini imzalar, isteği yineler.
// Kullanım: npm run client -w payments/x402-proto   (.env içinde BUYER_PRIVATE_KEY gerekir)
import { base58 } from "@scure/base";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { devnetPolicy, requireEnv } from "./config.ts";

try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch {
  /* .env yoksa ortam değişkenleri doğrudan kullanılır */
}

const url = process.argv[2] ?? process.env.RESOURCE_URL ?? "http://127.0.0.1:4021/demo";
const signer = await createKeyPairSignerFromBytes(base58.decode(requireEnv("BUYER_PRIVATE_KEY")));

const client = new x402Client()
  .register("solana:*", new ExactSvmScheme(signer))
  // Güvenlik politikası: yalnızca Devnet, yalnızca Devnet USDC, en fazla 0,01 USDC.
  .registerPolicy(devnetPolicy);

const fetchWithPayment = wrapFetchWithPayment(fetch, client);
console.log(`Alıcı: ${signer.address}\nİstek: GET ${url}`);
const res = await fetchWithPayment(url);
console.log(`Durum: ${res.status}`);
console.log(await res.text());

const header = res.headers.get("PAYMENT-RESPONSE");
if (header) {
  const s = decodePaymentResponseHeader(header);
  console.log("Kesinleşme:", JSON.stringify(s, null, 2));
  if (s.transaction) console.log(`Gezgin: https://explorer.solana.com/tx/${s.transaction}?cluster=devnet`);
}
process.exit(res.ok ? 0 : 1);
