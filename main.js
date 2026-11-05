import { VECTORS } from "./vectors.js";
import { WorkerClient } from "./worker-client.js";

const DEFAULT_INPUTS = {
  sha_chain: '{"seed":"hello","iterations":1000}',
  matmul: '{"seed":42,"n":64}',
  debug_panic: "{}",
};

const BENCH_CASES = [
  { module: "sha_chain", input: '{"seed":"bench","iterations":200000}' },
  { module: "matmul", input: '{"seed":1,"n":384}' },
];
const BENCH_REPEATS = 5;
const $ = (id) => document.getElementById(id);

const client = new WorkerClient();

// --- Liveness indicator: proves the main thread is not blocked by the task. ---
let frames = 0;
let lastFrame = performance.now();
let maxGap = 0;
function tick(now) {
  frames++;
  maxGap = Math.max(maxGap, now - lastFrame);
  lastFrame = now;
  $("ticks").textContent = String(frames);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

function setBusy(busy) {
  document.body.classList.toggle("busy", busy);
  for (const id of ["run", "vectors", "bench"]) $(id).disabled = busy;
  if (busy) maxGap = 0;
}

function fmt(ms) {
  return ms < 10 ? ms.toFixed(2) : ms.toFixed(1);
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function runOne() {
  const module = $("module").value;
  const impl = document.querySelector('input[name="impl"]:checked').value;
  setBusy(true);
  $("status").textContent = "çalışıyor…";
  $("output").textContent = "";
  const wall0 = performance.now();
  const res = await client.run(module, $("input").value, impl);
  const wall = performance.now() - wall0;
  setBusy(false);
  $("status").textContent = res.status === "ok" ? "tamam" : "HATA";
  $("status").className = res.status === "ok" ? "ok" : "err";
  $("output").textContent = res.output;
  const load = res.loadMs !== undefined ? `, WASM yükleme ${fmt(res.loadMs)} ms` : "";
  $("timing").textContent =
    `${res.impl || impl}: hesaplama ${fmt(res.durationMs)} ms (toplam ${fmt(wall)} ms${load}); ` +
    `çalışma sırasında en uzun kare aralığı ${fmt(maxGap)} ms`;
}

async function runVectors() {
  setBusy(true);
  const rows = [];
  let allOk = true;
  for (const v of VECTORS) {
    const row = { module: v.module, input: v.input };
    for (const impl of ["wasm", "js"]) {
      const res = await client.run(v.module, v.input, impl);
      row[impl] = res.status === "ok" && res.output === v.expected ? "OK" : `FAIL (${res.output})`;
      if (row[impl] !== "OK") allOk = false;
    }
    rows.push(row);
  }
  setBusy(false);
  $("status").textContent = allOk ? "tüm vektörler eşleşti" : "UYUŞMAZLIK var";
  $("status").className = allOk ? "ok" : "err";
  $("output").textContent = rows
    .map((r) => `${r.module} ${r.input}\n   wasm: ${r.wasm}   js: ${r.js}`)
    .join("\n");
  $("timing").textContent = `${navigator.userAgent}`;
}

async function runBench() {
  setBusy(true);
  $("status").textContent = "ölçülüyor…";
  const lines = ["görev | WASM (ms, medyan) | JS (ms, medyan) | JS/WASM", "-".repeat(56)];
  for (const c of BENCH_CASES) {
    const med = {};
    for (const impl of ["wasm", "js"]) {
      await client.run(c.module, c.input, impl); // warm-up (loads WASM, JIT)
      const times = [];
      for (let i = 0; i < BENCH_REPEATS; i++) {
        const res = await client.run(c.module, c.input, impl);
        if (res.status !== "ok") {
          times.push(NaN);
          break;
        }
        times.push(res.durationMs);
      }
      med[impl] = median(times);
    }
    lines.push(`${c.module} ${c.input} | ${fmt(med.wasm)} | ${fmt(med.js)} | ${(med.js / med.wasm).toFixed(2)}x`);
  }
  setBusy(false);
  $("status").textContent = "ölçüm bitti";
  $("status").className = "ok";
  $("output").textContent = lines.join("\n");
  $("timing").textContent = `${BENCH_REPEATS} tekrar, ilk koşu ısınma olarak atıldı; ${navigator.userAgent}`;
}

$("module").addEventListener("change", () => {
  $("input").value = DEFAULT_INPUTS[$("module").value] ?? "{}";
});
$("input").value = DEFAULT_INPUTS[$("module").value];
$("run").addEventListener("click", runOne);
$("vectors").addEventListener("click", runVectors);
$("bench").addEventListener("click", runBench);
