// Kullanım: npm run server -w payments/x402-proto   (.env içinde PLATFORM_ADDRESS gerekir)
import { appendFileSync } from "node:fs";
import { DEFAULT_FACILITATOR_URL, requireEnv } from "./config.ts";
import { createApp } from "./server.ts";

try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch {
  /* .env yoksa ortam değişkenleri doğrudan kullanılır */
}

const port = Number(process.env.PORT ?? 4021);
const app = createApp({
  payTo: requireEnv("PLATFORM_ADDRESS"),
  facilitatorUrl: process.env.FACILITATOR_URL ?? DEFAULT_FACILITATOR_URL,
  onSettled: (info) => {
    const line = JSON.stringify({ t: new Date().toISOString(), ...info });
    console.log(`Ödeme kesinleşti: ${line}`);
    console.log(`  Gezgin: https://explorer.solana.com/tx/${info.transaction}?cluster=devnet`);
    appendFileSync(new URL("../payments.log", import.meta.url), line + "\n");
  },
});
app.listen(port, () => console.log(`x402 sunucusu: http://127.0.0.1:${port}/demo  (ödeme alıcısı ${process.env.PLATFORM_ADDRESS})`));
