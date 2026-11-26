import type { IncomingMessage } from "node:http";
import { HTTPFacilitatorClient, x402HTTPResourceServer, x402ResourceServer, type HTTPAdapter, type HTTPRequestContext } from "@x402/core/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { DEVNET_USDC_MINT, SOLANA_DEVNET } from "../../../payments/x402-proto/src/config.ts";
import type { Coordinator, JobOptions, Quote } from "../coordinator.ts";

/**
 * x402 ile iş satın alma (9. hafta, Kapsam v3 §5; ROADMAP Aşama 8).
 *
 * POST /jobs bir x402 ödemesinin arkasındadır: fiyat (`exact`, Devnet USDC) gönderilen DAG'e ve
 * seçilen stratejiye göre hesaplanan üst sınırdır (Coordinator.quote). Akış:
 *   1. DAG ve stratejiler ödemeden ÖNCE doğrulanır; geçersiz istek 400 (alıcıdan para alınmaz).
 *   2. PAYMENT-SIGNATURE yoksa ya da geçersizse 402 + PAYMENT-REQUIRED (tutar = üst sınır).
 *   3. Ödeme facilitator'da doğrulanır ve zincirde KESİNLEŞTİRİLİR; ancak bundan sonra iş kuyruğa girer.
 *      Kesinleşme başarısızsa (ör. aynı ödemenin tekrarı) iş oluşturulmaz.
 *   4. 201 { jobId, quote, payment } + PAYMENT-RESPONSE başlığı; emanet defteri jobs tablosunda.
 * Ödeme imzası tutara bağlıdır: aynı imzayla daha büyük bir DAG göndermek tutarı değiştirir ve reddedilir.
 * Çekirdek (coordinator.ts) ödeme yöntemini bilmez; yalnızca kesinleşmiş ödemenin kaydını alır.
 */

export interface PaymentOptions {
  /** Ödemeyi alan platform adresi (Devnet). Bu adresin USDC token hesabı önceden var olmalı. */
  payTo: string;
  facilitatorUrl: string;
}

/** node:http isteğini x402'nin beklediği arayüze uyarlar; gövde önceden okunmuş JSON'dur. */
class NodeAdapter implements HTTPAdapter {
  private readonly req: IncomingMessage;
  private readonly url: URL;
  private readonly body: unknown;
  constructor(req: IncomingMessage, url: URL, body: unknown) {
    this.req = req;
    this.url = url;
    this.body = body;
  }
  getHeader(name: string) {
    const v = this.req.headers[name.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  }
  getMethod() { return this.req.method ?? "GET"; }
  getPath() { return this.url.pathname; }
  getUrl() { return this.url.toString(); }
  getAcceptHeader() { return this.getHeader("accept") ?? "application/json"; }
  getUserAgent() { return this.getHeader("user-agent") ?? ""; }
  getQueryParams() { return Object.fromEntries(this.url.searchParams); }
  getQueryParam(name: string) { return this.url.searchParams.get(name) ?? undefined; }
  getBody() { return this.body; }
}

export const jobOptionsFrom = (url: URL): JobOptions => ({
  scheduler: url.searchParams.get("scheduler") ?? undefined,
  verifier: url.searchParams.get("verifier") ?? undefined,
  source: url.searchParams.get("source") ?? undefined,
});

export type PaidSubmitResult =
  | { kind: "respond"; status: number; headers: Record<string, string>; body: unknown }
  | { kind: "submitted"; jobId: string; quote: Quote; transaction: string; payer: string | null; headers: Record<string, string> };

export class JobPayments {
  private readonly http: x402HTTPResourceServer;
  private readonly coord: Coordinator;
  readonly payTo: string;

  constructor(coord: Coordinator, opts: PaymentOptions) {
    this.coord = coord;
    this.payTo = opts.payTo;
    const facilitator = new HTTPFacilitatorClient({ url: opts.facilitatorUrl });
    const server = new x402ResourceServer(facilitator).register(SOLANA_DEVNET, new ExactSvmScheme());
    this.http = new x402HTTPResourceServer(server, {
      "POST /jobs": {
        accepts: [{
          scheme: "exact",
          network: SOLANA_DEVNET,
          payTo: opts.payTo,
          // Dinamik fiyat: üst sınır, gövdedeki DAG'e ve sorgudaki stratejiye göre.
          price: (ctx: HTTPRequestContext) => {
            const url = new URL(ctx.adapter.getUrl());
            const q = this.coord.quote(ctx.adapter.getBody?.(), jobOptionsFrom(url));
            return { asset: DEVNET_USDC_MINT, amount: String(q.capAtomic) };
          },
          maxTimeoutSeconds: 120,
        }],
        description: "Gönüllü hesaplama: DAG iş akışı (üst sınır; fark iş bitince iade edilir)",
        mimeType: "application/json",
      },
    });
  }

  /** Facilitator'ın desteklediği şemaları çeker; erişilemezse sunucu başlamaz. */
  initialize(): Promise<void> {
    return this.http.initialize();
  }

  /** Ödemeli iş gönderimi. `dag` zaten okunmuş JSON'dur ve quote() ile doğrulanmıştır. */
  async submit(req: IncomingMessage, url: URL, dag: unknown): Promise<PaidSubmitResult> {
    const quote = this.coord.quote(dag, jobOptionsFrom(url)); // geçersizse DagError (400), ödeme istenmez
    const adapter = new NodeAdapter(req, url, dag);
    const context: HTTPRequestContext = {
      adapter, path: url.pathname, method: "POST",
      paymentHeader: adapter.getHeader("payment-signature") ?? adapter.getHeader("x-payment"),
    };
    const result = await this.http.processHTTPRequest(context);
    if (result.type === "payment-error") {
      const r = result.response;
      return { kind: "respond", status: r.status, headers: r.headers, body: r.body ?? { error: "payment_required", quote } };
    }
    if (result.type === "no-payment-required") throw new Error("POST /jobs ödeme gerektirmeli");

    const settle = await this.http.processSettlement(
      result.paymentPayload, result.paymentRequirements, result.declaredExtensions,
      { request: context, responseBody: Buffer.alloc(0) },
    );
    if (!settle.success) {
      this.coord.db.log("warn", "payment_settle_failed", { reason: settle.errorReason, message: settle.errorMessage ?? null });
      const r = settle.response;
      return { kind: "respond", status: r.status, headers: { ...settle.headers, ...r.headers }, body: r.body ?? { error: settle.errorReason } };
    }
    const payer = settle.payer ?? null;
    const { jobId } = this.coord.submitJob(dag, jobOptionsFrom(url), { capAtomic: quote.capAtomic, transaction: settle.transaction, payer });
    this.coord.db.log("info", "job_paid", { jobId, transaction: settle.transaction, payer, capAtomic: quote.capAtomic, network: settle.network });
    return { kind: "submitted", jobId, quote, transaction: settle.transaction, payer, headers: settle.headers };
  }

  paymentInfo() {
    return { network: SOLANA_DEVNET, asset: DEVNET_USDC_MINT, payTo: this.payTo, scheme: "exact" };
  }
}
