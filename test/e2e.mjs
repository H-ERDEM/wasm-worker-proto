// End-to-end test in a real (headless) Chromium: module worker + WASM + UI.
// Set CHROMIUM_PATH to use a specific browser binary.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8123;
const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: root, stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await sleep(800);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage();
  const logs = [];
  page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
  await page.goto(`http://localhost:${PORT}/index.html`);

  // 1. Fixed test vectors, WASM and JS, inside the worker.
  await page.click("#vectors");
  await page.waitForFunction(() => document.getElementById("status").textContent !== "hazır", null, { timeout: 60000 });
  await page.waitForFunction(() => !document.getElementById("run").disabled, null, { timeout: 60000 });
  assert.equal(await page.textContent("#status"), "tüm vektörler eşleşti");
  console.log("vectors: OK");

  // 2. Long task must not block the main thread. The task must run for at least 500 ms to be
  // meaningful; fast machines (e.g. Apple M-series) finish 3M iterations sooner, so the
  // iteration count is doubled until the compute time is long enough.
  await page.selectOption("#module", "sha_chain");
  let iterations = 3_000_000, compute = 0, maxGap = 0, ticksBefore = 0, ticksAfter = 0;
  for (let attempt = 0; attempt < 5 && compute <= 500; attempt++, iterations *= 2) {
    await page.fill("#input", `{"seed":"long","iterations":${iterations}}`);
    ticksBefore = Number(await page.textContent("#ticks"));
    await page.click("#run");
    await page.waitForFunction(() => document.getElementById("status").textContent === "tamam", null, { timeout: 120000 });
    const timing = await page.textContent("#timing");
    ticksAfter = Number(await page.textContent("#ticks"));
    maxGap = Number(/en uzun kare aralığı ([\d.]+) ms/.exec(timing)[1]);
    compute = Number(/hesaplama ([\d.]+) ms/.exec(timing)[1]);
    console.log(`long task (${iterations} iterations): compute ${compute} ms, max frame gap ${maxGap} ms, frames ${ticksAfter - ticksBefore}`);
  }
  assert.ok(compute > 500, "task should be long enough to be meaningful");
  assert.ok(maxGap < 250, "main thread must stay responsive");
  assert.ok(ticksAfter - ticksBefore > 10, "frame counter must keep advancing");

  // 3. Error handling: bad input, unknown field, then a panic, then recovery.
  await page.fill("#input", "{not json");
  await page.click("#run");
  await page.waitForFunction(() => document.getElementById("status").textContent === "HATA");
  assert.match(await page.textContent("#output"), /invalid input/);

  await page.selectOption("#module", "debug_panic");
  await page.click("#run");
  await page.waitForFunction(() => !document.getElementById("run").disabled);
  assert.equal(await page.textContent("#status"), "HATA");
  console.log("panic reported as:", JSON.stringify(await page.textContent("#output")));

  await page.selectOption("#module", "matmul");
  await page.click("#run");
  await page.waitForFunction(() => document.getElementById("status").textContent === "tamam", null, { timeout: 30000 });
  assert.match(await page.textContent("#output"), /"hash":"[0-9a-f]{64}"/);
  console.log("recovery after panic: OK");

  // 4. WASM vs JS benchmark runs.
  await page.click("#bench");
  await page.waitForFunction(() => document.getElementById("status").textContent === "ölçüm bitti", null, { timeout: 180000 });
  console.log(await page.textContent("#output"));

  const bad = logs.filter((l) => /mime|streaming|not allowed|Failed to load/i.test(l));
  assert.equal(bad.length, 0, `unexpected console warnings:\n${bad.join("\n")}`);
  await browser.close();
  console.log("e2e: ALL OK");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => server.kill());
