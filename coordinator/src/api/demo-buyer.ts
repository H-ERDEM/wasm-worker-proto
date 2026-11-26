/**
 * Demo paneli için alıcı (ara demo, Hafta 9). Paneldeki "Öde ve gönder" düğmesi buraya gelir;
 * bu modül `submit --pay` ile aynı x402 akışını koordinatörün kendi HTTP adresine karşı yürütür
 * ve her adımı (402 → imza → kesinleşme) panelde gösterilmek üzere kaydeder.
 *
 * Alıcı anahtarı (BUYER_PRIVATE_KEY) yalnızca bu süreçte, Mac'teki .env'den okunur; tarayıcıya
 * hiç gönderilmez. Uç nokta yalnızca aynı makineden gelen isteği kabul eder (http.ts).
 * Gerçek alıcı ajanı 11. haftada ayrı bir süreç olacak.
 */
import { decodePaymentRequiredHeader } from "@x402/core/http";

export type WrapFetch = (f: typeof fetch) => typeof fetch;

export interface BuyStep {
  t: number;
  kind: "request" | "payment_required" | "signed" | "settled" | "rejected";
  detail: Record<string, unknown>;
}

export interface BuyResult {
  ok: boolean;
  status: number;
  steps: BuyStep[];
  jobId?: string;
  transaction?: string;
  payer?: string;
  error?: string;
}

/** Bütçe (atomik birim) ile sınırlı ödemeli fetch'i kurar. Gerçek ortamda Devnet anahtarıyla. */
export type PayingFetchFactory = (maxAtomic: bigint) => Promise<WrapFetch>;

export async function devnetPayingFetch(maxAtomic: bigint): Promise<WrapFetch> {
  const { base58 } = await import("@scure/base");
  const { createKeyPairSignerFromBytes } = await import("@solana/kit");
  const { wrapFetchWithPayment, x402Client } = await import("@x402/fetch");
  const { ExactSvmScheme } = await import("@x402/svm/exact/client");
  const { devnetPolicyWithMax, requireEnv } = await import("../../../payments/x402-proto/src/config.ts");
  const signer = await createKeyPairSignerFromBytes(base58.decode(requireEnv("BUYER_PRIVATE_KEY")));
  // Güvenlik politikası: yalnızca Devnet, yalnızca Devnet USDC, en fazla bütçe.
  const client = new x402Client().register("solana:*", new ExactSvmScheme(signer)).registerPolicy(devnetPolicyWithMax(maxAtomic));
  return (f) => wrapFetchWithPayment(f, client);
}

export class DemoBuyer {
  readonly baseUrl: string;
  readonly payingFetch: PayingFetchFactory;
  readonly address: string | null;

  constructor(baseUrl: string, payingFetch: PayingFetchFactory, address: string | null) {
    this.baseUrl = baseUrl;
    this.payingFetch = payingFetch;
    this.address = address;
  }

  async buy(dag: unknown, query: string, maxAtomic: bigint): Promise<BuyResult> {
    const steps: BuyStep[] = [];
    const step = (kind: BuyStep["kind"], detail: Record<string, unknown>) => steps.push({ t: Date.now(), kind, detail });
    // Her isteği ve yanıtı kaydeden fetch; ödeme sarmalayıcısı bunun üstüne kurulur.
    const recording: typeof fetch = async (input, init) => {
      const req = new Request(input, init);
      const signed = req.headers.has("payment-signature") || req.headers.has("x-payment");
      step(signed ? "signed" : "request", signed ? { header: "PAYMENT-SIGNATURE" } : { method: req.method, path: new URL(req.url).pathname });
      const res = await fetch(req);
      if (res.status === 402) {
        const raw = res.headers.get("payment-required");
        const pr = raw ? decodePaymentRequiredHeader(raw) : null;
        const a = pr?.accepts?.[0];
        step(signed ? "rejected" : "payment_required", a
          ? { amountAtomic: Number(a.amount), asset: a.asset, network: a.network, payTo: a.payTo, error: pr?.error ?? null }
          : { error: pr?.error ?? null });
      }
      return res;
    };
    let f: typeof fetch;
    try {
      f = (await this.payingFetch(maxAtomic))(recording);
    } catch (e) {
      return { ok: false, status: 500, steps, error: `alıcı anahtarı yüklenemedi: ${(e as Error).message}` };
    }
    let res: Response;
    try {
      res = await f(`${this.baseUrl}/jobs${query}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(dag),
      });
    } catch (e) {
      // İstemci politikası (bütçe, ağ) ödemeyi reddederse buraya düşer; ödeme yapılmamıştır.
      return { ok: false, status: 402, steps, error: (e as Error).message };
    }
    const body = (await res.json().catch(() => ({}))) as { jobId?: string; error?: string; payment?: { transaction: string; payer: string } };
    if (res.status !== 201) return { ok: false, status: res.status, steps, error: body.error ?? `durum ${res.status}` };
    step("settled", { transaction: body.payment?.transaction, payer: body.payment?.payer, jobId: body.jobId });
    return { ok: true, status: 201, steps, jobId: body.jobId, transaction: body.payment?.transaction, payer: body.payment?.payer };
  }
}
