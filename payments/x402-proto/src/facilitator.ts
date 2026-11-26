// Yerel x402 facilitator: istemcinin imzaladığı Devnet USDC işlemini doğrular, ücretini kendi hesabından
// ödeyerek zincire gönderir. Herkese açık facilitator'ın RPC sınırına (429) takılınca bunu kullanın.
// Kullanım: npm run facilitator -w payments/x402-proto   (.env içinde FACILITATOR_PRIVATE_KEY gerekir)
import express from "express";
import { base58 } from "@scure/base";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { x402Facilitator } from "@x402/core/facilitator";
import { toFacilitatorSvmSigner } from "@x402/svm";
import { registerExactSvmScheme } from "@x402/svm/exact/facilitator";
import { SOLANA_DEVNET } from "./config.ts";

export interface FacilitatorOptions {
  /** Facilitator hesabının gizli anahtarı (base58, 64 bayt). İşlem ücretini bu hesap öder: Devnet SOL gerekir. */
  privateKey: string;
  /** Devnet RPC adresi. Boşsa SDK'nın varsayılan herkese açık RPC'si kullanılır (sınırlı). */
  rpcUrl?: string;
}

export async function createFacilitatorApp(opts: FacilitatorOptions) {
  const keySigner = await createKeyPairSignerFromBytes(base58.decode(opts.privateKey));
  const signer = toFacilitatorSvmSigner(keySigner, opts.rpcUrl ? { defaultRpcUrl: opts.rpcUrl } : undefined);
  const facilitator = registerExactSvmScheme(new x402Facilitator(), { signer, networks: SOLANA_DEVNET });

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.get("/supported", (_req, res) => res.json(facilitator.getSupported()));
  app.post("/verify", async (req, res) => {
    try {
      res.json(await facilitator.verify(req.body.paymentPayload, req.body.paymentRequirements));
    } catch (e) {
      console.error("verify hatası:", e instanceof Error ? e.message : e);
      res.status(400).json({ isValid: false, invalidReason: "verify_error", invalidMessage: String((e as Error).message) });
    }
  });
  app.post("/settle", async (req, res) => {
    try {
      const result = await facilitator.settle(req.body.paymentPayload, req.body.paymentRequirements);
      console.log(`settle: success=${result.success} tx=${result.transaction ?? "-"} ${result.errorReason ?? ""} ${result.errorMessage ?? ""}`);
      res.json(result);
    } catch (e) {
      console.error("settle hatası:", e instanceof Error ? e.message : e);
      res.status(400).json({ success: false, errorReason: "settle_error", errorMessage: String((e as Error).message), transaction: "", network: SOLANA_DEVNET });
    }
  });
  return { app, address: keySigner.address };
}
