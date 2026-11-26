// Kullanım: npm run facilitator -w payments/x402-proto
import { requireEnv } from "./config.ts";
import { createFacilitatorApp } from "./facilitator.ts";

try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch {
  /* .env yoksa ortam değişkenleri doğrudan kullanılır */
}

const port = Number(process.env.FACILITATOR_PORT ?? 4022);
const { app, address } = await createFacilitatorApp({
  privateKey: requireEnv("FACILITATOR_PRIVATE_KEY"),
  rpcUrl: process.env.SOLANA_RPC_URL,
});
app.listen(port, "127.0.0.1", () => {
  console.log(`Yerel facilitator: http://127.0.0.1:${port}  (ücret ödeyen hesap ${address})`);
  console.log(`RPC: ${process.env.SOLANA_RPC_URL ?? "SDK varsayılanı (herkese açık Devnet RPC)"}`);
  console.log("Bu hesapta Devnet SOL olmalı: https://faucet.solana.com");
});
