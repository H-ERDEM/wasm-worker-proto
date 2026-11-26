import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Kullanım: npm run submit -- shared/examples/three-task-dag.json [--url http://127.0.0.1:8787] [--wait]
//           [--scheduler fifo|fastest|reputation] [--verifier fixed2|fixed3|adaptive|accept_first]
//           [--quote]                  yalnızca fiyat teklifi (iş oluşturmaz)
//           [--pay [--max-usdc 1]]     x402 ile öde (alıcı anahtarı payments/x402-proto/.env: BUYER_PRIVATE_KEY);
//                                      üst sınır --max-usdc'yi (varsayılan 1 USDC) aşarsa ödeme yapılmaz
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const valued = new Set(["--url", "--scheduler", "--verifier", "--max-usdc"].map((f) => args.indexOf(f) + 1).filter((i) => i > 0));
const file = args.find((a, i) => !a.startsWith("--") && !valued.has(i));
const base = flag("--url") ?? process.env.COORDINATOR_URL ?? "http://127.0.0.1:8787";
const query = new URLSearchParams(
  Object.entries({ scheduler: flag("--scheduler"), verifier: flag("--verifier"), source: "cli" }).filter(([, v]) => v) as [string, string][],
).toString();
const qs = query ? `?${query}` : "";
if (!file) {
  console.error("Kullanım: npm run submit -- <dag.json> [--url <adres>] [--wait] [--quote] [--pay [--max-usdc 1] [--replay]]");
  process.exit(2);
}

// npm workspace komutları alt klasörde çalışır; yolu komutun verildiği klasöre göre çöz.
const body = readFileSync(resolve(process.env.INIT_CWD ?? process.cwd(), file), "utf8");
const post = (path: string, f: typeof fetch = fetch) =>
  f(`${base}${path}${qs}`, { method: "POST", headers: { "content-type": "application/json" }, body });

interface QuoteResp { quote: { tasks: number; verifier: string; cap: string; capAtomic: number }; payment: { payTo: string; network: string } | null; error?: string }
const qres = await post("/quote");
const q = (await qres.json()) as QuoteResp;
if (!qres.ok) {
  console.error(`Hata (${qres.status}): ${q.error}`);
  process.exit(1);
}
console.log(`Teklif: ${q.quote.tasks} görev, doğrulayıcı ${q.quote.verifier}, üst sınır ${q.quote.cap} USDC` +
  (q.payment ? ` (ödeme ${q.payment.network}, alıcı ${q.payment.payTo})` : " (koordinatörde ödeme kapalı)"));
if (args.includes("--quote")) process.exit(0);

let doFetch: typeof fetch = fetch;
const recorded: { paid?: { headers: Headers; body: string } } = {};
if (args.includes("--pay") && !q.payment) {
  console.log("Koordinatörde ödeme kapalı; --pay yok sayıldı.");
} else if (args.includes("--pay")) {
  const maxUsdc = Number(flag("--max-usdc") ?? 1);
  const maxAtomic = BigInt(Math.round(maxUsdc * 1e6));
  if (BigInt(q.quote.capAtomic) > maxAtomic) {
    console.error(`Üst sınır (${q.quote.cap} USDC) bütçeyi (${maxUsdc} USDC) aşıyor; ödeme yapılmadı. --max-usdc ile artırın.`);
    process.exit(1);
  }
  try {
    process.loadEnvFile(fileURLToPath(new URL("../../../payments/x402-proto/.env", import.meta.url)));
  } catch {
    /* .env yoksa ortam değişkenleri doğrudan kullanılır */
  }
  const { base58 } = await import("@scure/base");
  const { createKeyPairSignerFromBytes } = await import("@solana/kit");
  const { wrapFetchWithPayment, x402Client } = await import("@x402/fetch");
  const { ExactSvmScheme } = await import("@x402/svm/exact/client");
  const { devnetPolicyWithMax, requireEnv } = await import("../../../payments/x402-proto/src/config.ts");
  let key: string;
  try {
    key = requireEnv("BUYER_PRIVATE_KEY");
  } catch (e) {
    console.error(`${(e as Error).message}. Anahtar üretmek için: npm run keys -w payments/x402-proto`);
    process.exit(1);
  }
  const signer = await createKeyPairSignerFromBytes(base58.decode(key));
  // Güvenlik politikası: yalnızca Devnet, yalnızca Devnet USDC, en fazla --max-usdc.
  const client = new x402Client().register("solana:*", new ExactSvmScheme(signer)).registerPolicy(devnetPolicyWithMax(maxAtomic));
  // --replay için: ödeme başlığını taşıyan isteği (ikinci deneme) kaydet.
  const recording: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    if (req.headers.has("payment-signature") || req.headers.has("x-payment")) {
      recorded.paid = { headers: new Headers(req.headers), body: await req.clone().text() };
    }
    return fetch(req);
  };
  doFetch = wrapFetchWithPayment(recording, client);
  console.log(`Alıcı: ${signer.address}; bütçe ${maxUsdc} USDC`);
}

const res = await post("/jobs", doFetch);
const out = (await res.json()) as { jobId?: string; error?: string; payment?: { transaction: string; payer: string } };
if (res.status === 402) {
  console.error(`Ödeme gerekli (402): üst sınır ${q.quote.cap} USDC. --pay ile ödeyin.` + (out.error ? ` Neden: ${out.error}` : ""));
  process.exit(1);
}
if (!res.ok) {
  console.error(`Hata (${res.status}): ${out.error ?? JSON.stringify(out)}`);
  process.exit(1);
}
console.log(`İş gönderildi: ${out.jobId}`);
if (out.payment) {
  console.log(`Ödeme kesinleşti: ${out.payment.transaction} (ödeyen ${out.payment.payer})`);
  console.log(`  Gezgin: https://explorer.solana.com/tx/${out.payment.transaction}?cluster=devnet`);
}

// Tekrar koruması denemesi: aynı imzalı ödeme başlığıyla aynı isteği bir kez daha gönder.
// Beklenen: ödeme zaten kesinleştiği için facilitator reddeder, ikinci iş oluşmaz.
if (args.includes("--replay")) {
  const paidRequest = recorded.paid;
  if (!paidRequest) {
    console.error("--replay: kaydedilmiş ödemeli istek yok (--pay ile birlikte kullanın).");
  } else {
    const again = await fetch(`${base}/jobs${qs}`, { method: "POST", headers: paidRequest.headers, body: paidRequest.body });
    const body = (await again.json().catch(() => ({}))) as { jobId?: string; error?: string };
    if (again.status === 201) {
      console.error(`UYARI: aynı ödeme ikinci kez kabul edildi, yeni iş ${body.jobId}. Tekrar koruması çalışmadı.`);
      process.exit(1);
    }
    console.log(`Tekrar denemesi: aynı ödeme başlığı reddedildi (${again.status})` + (body.error ? `: ${body.error}` : "") + "; ikinci iş oluşmadı.");
  }
}

if (args.includes("--wait")) {
  for (;;) {
    const job = (await (await fetch(`${base}/jobs/${out.jobId}`)).json()) as { status: string };
    if (job.status !== "RUNNING") {
      console.log(JSON.stringify(job, null, 2));
      process.exit(job.status === "COMPLETED" ? 0 : 1);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}
