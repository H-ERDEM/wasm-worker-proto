import { DEFAULT_FACILITATOR_URL } from "../../payments/x402-proto/src/config.ts";
import { createServer } from "./server.ts";

// Kullanım: npm run coordinator   (PORT, HOST, DB_PATH ortam değişkenleriyle)
// Telefon gibi aynı ağdaki cihazlar için HOST=0.0.0.0 verin.
// PAYMENTS=1 ile POST /jobs x402 ödemesinin arkasına alınır: PLATFORM_ADDRESS (ve isteğe bağlı
// FACILITATOR_URL) payments/x402-proto/.env dosyasından ya da ortamdan okunur.
const paymentsOn = process.env.PAYMENTS === "1";
if (paymentsOn) {
  try {
    process.loadEnvFile(new URL("../../payments/x402-proto/.env", import.meta.url).pathname);
  } catch {
    /* .env yoksa ortam değişkenleri doğrudan kullanılır */
  }
  if (!process.env.PLATFORM_ADDRESS) throw new Error("PAYMENTS=1 için PLATFORM_ADDRESS gerekli (payments/x402-proto/.env)");
}
const server = await createServer({
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? "127.0.0.1",
  dbPath: process.env.DB_PATH ?? "coordinator.db",
  payments: paymentsOn
    ? { payTo: process.env.PLATFORM_ADDRESS!, facilitatorUrl: process.env.FACILITATOR_URL ?? DEFAULT_FACILITATOR_URL }
    : undefined,
});
console.log(`Koordinatör çalışıyor: ${server.url}  (worker WebSocket: ${server.wsUrl})`);
console.log(`Varsayılan zamanlayıcı: ${server.coord.scheduler.name}, doğrulayıcı: ${server.coord.verifier.name} (iş başına ?scheduler=&verifier= ile değişir)`);
console.log(`Sınama işi kâhini: ${server.coord.oracle.impl}; WASM paketi: ${server.coord.wasmHash ?? "derlenmemiş"}`);
console.log(server.payments
  ? `Ödeme: x402 açık (Devnet USDC, alıcı ${server.payments.payTo}); POST /jobs ödemesiz 402 döner`
  : "Ödeme: kapalı (PAYMENTS=1 ile açılır)");

const shutdown = async () => {
  await server.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
