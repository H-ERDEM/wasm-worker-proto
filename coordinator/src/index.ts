import { fileURLToPath } from "node:url";
import { DEFAULT_FACILITATOR_URL } from "../../payments/x402-proto/src/config.ts";
import { createServer } from "./server.ts";
import { devnetPayingFetch } from "./api/demo-buyer.ts";
import { DEVNET_RPC_URL, solanaChain } from "./solana-chain.ts";
import { DEVNET_USDC_MINT } from "../../payments/x402-proto/src/config.ts";

// Kullanım: npm run coordinator   (PORT, HOST, DB_PATH ortam değişkenleriyle)
// Telefon gibi aynı ağdaki cihazlar için HOST=0.0.0.0 verin.
// PAYMENTS=1 ile POST /jobs x402 ödemesinin arkasına alınır: PLATFORM_ADDRESS (ve isteğe bağlı
// FACILITATOR_URL) payments/x402-proto/.env dosyasından ya da ortamdan okunur.
const paymentsOn = process.env.PAYMENTS === "1";
if (paymentsOn) {
  try {
    process.loadEnvFile(fileURLToPath(new URL("../../payments/x402-proto/.env", import.meta.url)));
  } catch {
    /* .env yoksa ortam değişkenleri doğrudan kullanılır */
  }
  if (!process.env.PLATFORM_ADDRESS) throw new Error("PAYMENTS=1 için PLATFORM_ADDRESS gerekli (payments/x402-proto/.env)");
}
// PAYOUTS=1: iş kesinleşince worker'lara ödeme ve alıcıya iade Devnet'te gerçekten gönderilir
// (platform cüzdanından; PLATFORM_PRIVATE_KEY .env'de, işlem ücreti için Devnet SOL gerekir).
// Kapalıyken plan yine yazılır, gönderim beklemede kalır.
const payoutsOn = process.env.PAYOUTS === "1";
if (payoutsOn && !paymentsOn) throw new Error("PAYOUTS=1 için PAYMENTS=1 de gerekli (ödemeler alıcının ödediği emanetten yapılır)");
if (payoutsOn && !process.env.PLATFORM_PRIVATE_KEY) throw new Error("PAYOUTS=1 için PLATFORM_PRIVATE_KEY gerekli (payments/x402-proto/.env)");
const chain = payoutsOn
  ? await solanaChain({ rpcUrl: process.env.RPC_URL ?? DEVNET_RPC_URL, platformSecret: process.env.PLATFORM_PRIVATE_KEY!, mint: DEVNET_USDC_MINT })
  : null;
if (chain && chain.address !== process.env.PLATFORM_ADDRESS) throw new Error("PLATFORM_PRIVATE_KEY, PLATFORM_ADDRESS ile eşleşmiyor");
const server = await createServer({
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? "127.0.0.1",
  dbPath: process.env.DB_PATH ?? "coordinator.db",
  payments: paymentsOn
    ? { payTo: process.env.PLATFORM_ADDRESS!, facilitatorUrl: process.env.FACILITATOR_URL ?? DEFAULT_FACILITATOR_URL }
    : undefined,
  // Demo paneli alıcısı: anahtar .env'de varsa; anahtarın kendisi loglanmaz, panele gönderilmez.
  payouts: { chain },
  demoBuyer: paymentsOn && process.env.BUYER_PRIVATE_KEY
    ? { payingFetch: devnetPayingFetch, address: process.env.BUYER_ADDRESS ?? null }
    : undefined,
});
console.log(`Koordinatör çalışıyor: ${server.url}  (worker WebSocket: ${server.wsUrl})`);
console.log(`Varsayılan zamanlayıcı: ${server.coord.scheduler.name}, doğrulayıcı: ${server.coord.verifier.name} (iş başına ?scheduler=&verifier= ile değişir)`);
console.log(`Sınama işi kâhini: ${server.coord.oracle.impl}; WASM paketi: ${server.coord.wasmHash ?? "derlenmemiş"}`);
console.log(server.payments
  ? `Ödeme: x402 açık (Devnet USDC, alıcı ${server.payments.payTo}); POST /jobs ödemesiz 402 döner`
  : "Ödeme: kapalı (PAYMENTS=1 ile açılır)");
if (server.payments) {
  console.log(chain
    ? `Worker ödemeleri: açık (Devnet, ${process.env.RPC_URL ?? DEVNET_RPC_URL}; platform cüzdanından)`
    : "Worker ödemeleri: plan yazılır, gönderim kapalı (PAYOUTS=1 ile açılır)");
}
console.log(`Demo paneli: ${server.url}/panel` + (server.demo.buyer ? " (alıcı hazır; yalnızca bu makineden ödeme yapar)" : ""));

const shutdown = async () => {
  await server.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
