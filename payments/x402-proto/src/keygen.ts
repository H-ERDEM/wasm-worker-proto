// İki Devnet anahtar çifti (alıcı, platform) üretir ve .env dosyasına yazar. .env asla commit edilmez.
// Kullanım: npm run keys -w payments/x402-proto
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { base58 } from "@scure/base";

async function keypair() {
  const kp = (await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as webcrypto.CryptoKeyPair;
  const pkcs8 = new Uint8Array(await webcrypto.subtle.exportKey("pkcs8", kp.privateKey));
  const pub = new Uint8Array(await webcrypto.subtle.exportKey("raw", kp.publicKey));
  const secret = new Uint8Array(64); // Solana biçimi: 32 bayt tohum + 32 bayt açık anahtar
  secret.set(pkcs8.slice(-32), 0);
  secret.set(pub, 32);
  return { address: base58.encode(pub), secret: base58.encode(secret) };
}

const envPath = new URL("../.env", import.meta.url);
if (process.argv.includes("--facilitator")) {
  // Yerel facilitator için üçüncü bir anahtar çifti ekler; mevcut alıcı ve platform anahtarlarına dokunmaz.
  if (!existsSync(envPath)) {
    console.error(".env yok; önce `npm run keys -w payments/x402-proto` çalıştırın.");
    process.exit(1);
  }
  if (readFileSync(envPath, "utf8").includes("FACILITATOR_PRIVATE_KEY=")) {
    console.error("FACILITATOR_PRIVATE_KEY zaten var.");
    process.exit(1);
  }
  const f = await keypair();
  appendFileSync(envPath, `FACILITATOR_PRIVATE_KEY=${f.secret}\nFACILITATOR_ADDRESS=${f.address}\n`);
  console.log(`Facilitator adresi: ${f.address}\n→ .env güncellendi\nSonraki adım: bu adrese https://faucet.solana.com üzerinden Devnet SOL alın.`);
  process.exit(0);
}
if (existsSync(envPath) && !process.argv.includes("--force")) {
  console.error(".env zaten var; üzerine yazmak için --force verin.");
  process.exit(1);
}
const buyer = await keypair();
const platform = await keypair();
writeFileSync(
  envPath,
  [
    "# YALNIZCA Devnet için atılabilir anahtarlar. Commit etmeyin.",
    `BUYER_PRIVATE_KEY=${buyer.secret}`,
    `BUYER_ADDRESS=${buyer.address}`,
    `PLATFORM_ADDRESS=${platform.address}`,
    `PLATFORM_PRIVATE_KEY=${platform.secret}`,
    "FACILITATOR_URL=https://x402.org/facilitator",
    "",
  ].join("\n"),
  { mode: 0o600 },
);
console.log(`Alıcı adresi:   ${buyer.address}\nPlatform adresi: ${platform.address}\n→ .env yazıldı`);
console.log("Sonraki adım: alıcı adresine https://faucet.circle.com üzerinden Solana Devnet USDC alın.");
