import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Kullanım: npm run submit -- shared/examples/three-task-dag.json [--url http://127.0.0.1:8787] [--wait]
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const urlIdx = args.indexOf("--url");
const base = urlIdx >= 0 ? args[urlIdx + 1] : process.env.COORDINATOR_URL ?? "http://127.0.0.1:8787";
if (!file) {
  console.error("Kullanım: npm run submit -- <dag.json> [--url <adres>] [--wait]");
  process.exit(2);
}

// npm workspace komutları alt klasörde çalışır; yolu komutun verildiği klasöre göre çöz.
const path = resolve(process.env.INIT_CWD ?? process.cwd(), file);
const res = await fetch(`${base}/jobs`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: readFileSync(path, "utf8"),
});
const body = (await res.json()) as { jobId?: string; error?: string };
if (!res.ok) {
  console.error(`Hata (${res.status}): ${body.error}`);
  process.exit(1);
}
console.log(`İş gönderildi: ${body.jobId}`);

if (args.includes("--wait")) {
  for (;;) {
    const job = (await (await fetch(`${base}/jobs/${body.jobId}`)).json()) as { status: string };
    if (job.status !== "RUNNING") {
      console.log(JSON.stringify(job, null, 2));
      process.exit(job.status === "COMPLETED" ? 0 : 1);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}
