import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Kullanım: npm run submit -- shared/examples/three-task-dag.json [--url http://127.0.0.1:8787] [--wait]
//           [--scheduler fifo|fastest|reputation] [--verifier fixed2|fixed3|adaptive|accept_first]
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const valued = new Set(["--url", "--scheduler", "--verifier"].map((f) => args.indexOf(f) + 1).filter((i) => i > 0));
const file = args.find((a, i) => !a.startsWith("--") && !valued.has(i));
const base = flag("--url") ?? process.env.COORDINATOR_URL ?? "http://127.0.0.1:8787";
const query = new URLSearchParams(
  Object.entries({ scheduler: flag("--scheduler"), verifier: flag("--verifier") }).filter(([, v]) => v) as [string, string][],
).toString();
if (!file) {
  console.error("Kullanım: npm run submit -- <dag.json> [--url <adres>] [--wait]");
  process.exit(2);
}

// npm workspace komutları alt klasörde çalışır; yolu komutun verildiği klasöre göre çöz.
const path = resolve(process.env.INIT_CWD ?? process.cwd(), file);
const res = await fetch(`${base}/jobs${query ? `?${query}` : ""}`, {
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
