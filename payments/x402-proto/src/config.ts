// x402 prototipinin sabitleri (Hafta 6–7 raporu §1.6). Kaynak: solana.com x402 rehberi ve @x402/svm 2.30.
// Not: x402 paketleri hızlı değişiyor; değerleri güncellerken erişim tarihini docs/ altına yazın.

/** Solana Devnet, CAIP-2 biçiminde (x402 v2). */
export const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as const;

/** Devnet USDC mint adresi (Circle). Gerçek USDC değildir, değeri yoktur. */
export const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

/** Varsayılan facilitator: test ağlarını (Solana Devnet dahil) destekleyen herkese açık facilitator. */
export const DEFAULT_FACILITATOR_URL = "https://x402.org/facilitator";

/** Korunan kaynağın fiyatı (USD cinsinden; USDC'ye çevrilir). 0,01 USDC = 10 000 atomik birim. */
export const DEMO_PRICE = "$0.01";

/** İstemcinin ödemeye razı olduğu en yüksek tutar (atomik USDC birimi). */
export const CLIENT_MAX_ATOMIC = 10_000n;

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} ortam değişkeni gerekli (bkz. payments/x402-proto/.env.example)`);
  return v;
}

/** İstemci harcama politikası: yalnızca Devnet, yalnızca Devnet USDC, en fazla CLIENT_MAX_ATOMIC. */
export function devnetPolicy<R extends { network: string; asset: string; amount: string }>(_version: number, reqs: R[]): R[] {
  return reqs.filter((r) => r.network === SOLANA_DEVNET && r.asset === DEVNET_USDC_MINT && BigInt(r.amount) <= CLIENT_MAX_ATOMIC);
}
