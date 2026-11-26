// x402 kaynak sunucusu: GET /demo ödeme ister (402 → ödeme → 200). 8. aşamada aynı ara katman
// koordinatörün POST /jobs yolunun önüne konacak; çekirdek ödeme yöntemini bilmeyecek.
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { DEMO_PRICE, SOLANA_DEVNET } from "./config.ts";

export interface ServerOptions {
  payTo: string;
  facilitatorUrl: string;
  price?: string;
  /** Her başarılı ödemede çağrılır (işlem imzası, ödeyen, tutar). */
  onSettled?: (info: { transaction: string; payer?: string; network: string }) => void;
}

export function createApp(opts: ServerOptions) {
  const facilitator = new HTTPFacilitatorClient({ url: opts.facilitatorUrl });
  const resourceServer = new x402ResourceServer(facilitator).register(SOLANA_DEVNET, new ExactSvmScheme());
  // Facilitator ödemeyi kesinleştiremezse nedenini sunucu terminaline yazar (ör. RPC 429 sınırı).
  resourceServer.onSettleFailure(async (ctx) => {
    console.error(`Ödeme kesinleştirilemedi: ${ctx.error?.message ?? ctx.error}`);
  });

  const app = express();
  app.get("/health", (_req, res) => res.json({ ok: true }));

  // Ödeme kesinleşince facilitator'ın cevabı PAYMENT-RESPONSE başlığında döner; kaydı buradan alırız.
  app.use((_req, res, next) => {
    res.on("finish", () => {
      const header = res.getHeader("PAYMENT-RESPONSE");
      if (typeof header !== "string") return;
      try {
        const s = decodePaymentResponseHeader(header);
        if (s.success && s.transaction) opts.onSettled?.({ transaction: s.transaction, payer: s.payer, network: s.network });
      } catch {
        /* bozuk başlık: kaydetme */
      }
    });
    next();
  });

  app.use(
    paymentMiddleware(
      {
        "GET /demo": {
          accepts: [{ scheme: "exact", price: opts.price ?? DEMO_PRICE, network: SOLANA_DEVNET, payTo: opts.payTo }],
          description: "Gönüllü hesaplama platformu: x402 Devnet prototipi",
          mimeType: "application/json",
        },
      },
      resourceServer,
    ),
  );

  app.get("/demo", (_req, res) => {
    res.json({ message: "Ödeme alındı. 8. aşamada burası POST /jobs olacak.", at: new Date().toISOString() });
  });

  return app;
}
