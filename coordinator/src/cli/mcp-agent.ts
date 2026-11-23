/**
 * Uçtan uca senaryo (10.3), Devnet'te: MCP istemcisi olarak iş satın alır.
 *
 *   npm run mcp-agent -- shared/examples/image-pipeline.json --verifier adaptive --max-usdc 0.1
 *
 * MCP sunucusunu (src/mcp/stdio.ts) alt süreç olarak başlatır ve stdio üzerinden konuşur; ödeme
 * x402 MCP taşımasıyla (_meta["x402/payment"]) yapılır. Alıcı anahtarı payments/x402-proto/.env'den
 * (BUYER_PRIVATE_KEY) okunur; istemci politikası yalnızca Devnet, Devnet USDC ve bütçe kadar öder.
 * Koordinatör ayrıca çalışıyor olmalı: PAYMENTS=1 [PAYOUTS=1] npm run coordinator
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { runScenario, type PaymentRequired } from "../mcp/scenario.ts";

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const file = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
if (!file) {
  console.error("Kullanım: npm run mcp-agent -- <dag.json> [--verifier adaptive] [--scheduler fifo] [--max-usdc 1]");
  process.exit(1);
}
const dag = JSON.parse(readFileSync(resolve(process.env.INIT_CWD ?? process.cwd(), file), "utf8"));
const maxUsdc = Number(flag("--max-usdc") ?? 1);
const maxAtomic = Math.round(maxUsdc * 1e6);
const coordinatorUrl = process.env.COORDINATOR_URL ?? "http://127.0.0.1:8787";

try {
  process.loadEnvFile(new URL("../../../payments/x402-proto/.env", import.meta.url).pathname);
} catch {
  /* .env yoksa ortam değişkenleri doğrudan kullanılır */
}

async function devnetPay(pr: PaymentRequired): Promise<unknown> {
  const { base58 } = await import("@scure/base");
  const { createKeyPairSignerFromBytes } = await import("@solana/kit");
  const { x402Client } = await import("@x402/core/client");
  const { ExactSvmScheme } = await import("@x402/svm/exact/client");
  const { devnetPolicyWithMax, requireEnv } = await import("../../../payments/x402-proto/src/config.ts");
  const signer = await createKeyPairSignerFromBytes(base58.decode(requireEnv("BUYER_PRIVATE_KEY")));
  const client = new x402Client().register("solana:*", new ExactSvmScheme(signer)).registerPolicy(devnetPolicyWithMax(BigInt(maxAtomic)));
  return client.createPaymentPayload(pr as never);
}

const stdio = fileURLToPath(new URL("../mcp/stdio.ts", import.meta.url));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--disable-warning=ExperimentalWarning", stdio],
  env: { ...process.env, COORDINATOR_URL: coordinatorUrl } as Record<string, string>,
  stderr: "ignore",
});
const client = new Client({ name: "ornek-ajan", version: "0.10.0" }, { capabilities: {} });
await client.connect(transport);
console.log(`MCP sunucusuna bağlanıldı (stdio) → koordinatör ${coordinatorUrl}`);

try {
  const out = await runScenario(client, {
    dag, verifier: flag("--verifier"), scheduler: flag("--scheduler"), maxAtomic, pay: devnetPay,
    log: (l) => console.log(l), pollMs: 1000, payoutWaitMs: 60_000,
  });
  if (out.settle?.transaction) console.log(`  Ödeme: https://explorer.solana.com/tx/${out.settle.transaction}?cluster=devnet`);
  console.log("Çıktılar:", JSON.stringify(out.outputs));
  const p = out.payment as { capAtomic: number; realizedAtomic: number; refundDueAtomic: number; payouts?: { kind: string; payee: string; amountAtomic: number; status: string; transaction: string | null }[] } | null;
  if (p) {
    console.log(`Defter: ödenen ${p.capAtomic / 1e6}, gerçekleşen ${p.realizedAtomic / 1e6}, iade ${p.refundDueAtomic / 1e6} USDC`);
    for (const x of p.payouts ?? []) {
      const who = x.kind === "refund" ? "alıcıya iade" : `worker ${x.payee}`;
      console.log(`  ${who}: ${x.amountAtomic / 1e6} USDC · ${x.status}` + (x.transaction ? ` · https://explorer.solana.com/tx/${x.transaction}?cluster=devnet` : ""));
    }
  }
} catch (e) {
  console.error(`Hata: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await client.close();
}
