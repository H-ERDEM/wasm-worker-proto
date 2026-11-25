/** Ağ gerektirmeyen sahte x402 facilitator (Solana Devnet, exact). "BAD" işlemi doğrulamada, aynı işlemin tekrarını kesinleştirmede reddeder. */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SOLANA_DEVNET } from "../../payments/x402-proto/src/config.ts";

export const FAKE_BUYER = "FKqFgXvXGih6KDYsLSLNAk5WrANM68ZfgkfGUWmEeyrF";
export const FAKE_FEE_PAYER = "2wmVCSfPxGPjrnMMn7rchp4uaeoTqN39mXFC2zhPdri9";

export async function startFakeFacilitator(): Promise<{ url: string; settled: Set<string>; close(): void }> {
  const settled = new Set<string>();
  const srv: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    res.setHeader("content-type", "application/json");
    const tx = body.paymentPayload?.payload?.transaction as string | undefined;
    if (req.url === "/supported") {
      return res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: SOLANA_DEVNET, extra: { feePayer: FAKE_FEE_PAYER } }], extensions: [], signers: {} }));
    }
    if (req.url === "/verify") {
      if (tx === "BAD") return res.end(JSON.stringify({ isValid: false, invalidReason: "invalid_exact_svm_transaction_simulation_failed" }));
      return res.end(JSON.stringify({ isValid: true, payer: FAKE_BUYER }));
    }
    if (req.url === "/settle") {
      if (settled.has(tx!)) return res.end(JSON.stringify({ success: false, errorReason: "invalid_exact_svm_transaction_already_processed", transaction: "", network: SOLANA_DEVNET }));
      settled.add(tx!);
      return res.end(JSON.stringify({ success: true, transaction: `SIG_${tx}`, network: SOLANA_DEVNET, payer: FAKE_BUYER }));
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, settled, close: () => srv.close() };
}
