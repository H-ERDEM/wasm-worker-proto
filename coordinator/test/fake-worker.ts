/**
 * Testler için Node'da çalışan sahte worker. Görevleri wasm-worker-proto README'sindeki tanımlarla
 * aynı biçimde hesaplar (vektörlerle doğrulandı), böylece koordinatör tarayıcı olmadan uçtan uca test edilir.
 * Gerçek tarayıcı worker'ı (worker-web/ws-client.js) 3. aşamada aynı protokolü konuşur.
 */
import { createHash } from "node:crypto";
import WebSocket from "ws";

export function shaChain(seed: string, iterations: number): string {
  let h = createHash("sha256").update(seed, "utf8").digest();
  for (let i = 1; i < iterations; i++) h = createHash("sha256").update(h).digest();
  return `{"hash":"${h.toString("hex")}","iterations":${iterations}}`;
}

function mulberry32(a: number) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

export function matmul(seed: number, n: number): string {
  const rnd = mulberry32(seed);
  const A = new Uint32Array(n * n), B = new Uint32Array(n * n), C = new Uint32Array(n * n);
  for (let i = 0; i < n * n; i++) A[i] = rnd();
  for (let i = 0; i < n * n; i++) B[i] = rnd();
  for (let i = 0; i < n; i++)
    for (let k = 0; k < n; k++) {
      const a = A[i * n + k];
      for (let j = 0; j < n; j++) C[i * n + j] = (C[i * n + j] + Math.imul(a, B[k * n + j])) >>> 0;
    }
  const buf = Buffer.alloc(n * n * 4);
  for (let i = 0; i < n * n; i++) buf.writeUInt32LE(C[i], i * 4);
  return `{"hash":"${createHash("sha256").update(buf).digest("hex")}","n":${n},"seed":${seed}}`;
}

export type Behavior =
  | "normal"
  | "close_on_assign" // görevi alınca sekmeyi kapatır gibi bağlantıyı keser
  | "silent_on_assign" // görevi alınca tamamen susar (donmuş sekme)
  | "invalid"; // hello'dan sonra şemaya uymayan mesaj gönderir

export interface FakeWorkerOptions {
  behavior?: Behavior;
  delayMs?: number;
  workerId?: string;
}

export interface FakeWorker {
  id: Promise<string>;
  assigns: { replicaId: number; module: string; input: string }[];
  closed: Promise<{ code: number }>;
  close(): void;
}

export function startFakeWorker(wsUrl: string, opts: FakeWorkerOptions = {}): FakeWorker {
  const behavior = opts.behavior ?? "normal";
  const ws = new WebSocket(wsUrl);
  const assigns: FakeWorker["assigns"] = [];
  let silent = false;
  let resolveId!: (id: string) => void;
  const id = new Promise<string>((r) => (resolveId = r));
  const closed = new Promise<{ code: number }>((r) => ws.on("close", (code) => r({ code })));

  ws.on("open", () => {
    ws.send(JSON.stringify({ type: "hello", consent: true, deviceClass: "node", impls: ["wasm"], userAgent: "fake-worker", ...(opts.workerId ? { workerId: opts.workerId } : {}) }));
  });

  ws.on("message", (data) => {
    if (silent) return;
    const msg = JSON.parse(data.toString());
    if (msg.type === "welcome") {
      resolveId(msg.workerId);
      if (behavior === "invalid") ws.send(JSON.stringify({ type: "result", replicaId: "not-a-number" }));
      return;
    }
    if (msg.type === "ping") return ws.send(JSON.stringify({ type: "pong", t: msg.t }));
    if (msg.type !== "assign") return;

    assigns.push({ replicaId: msg.replicaId, module: msg.module, input: msg.input });
    if (behavior === "close_on_assign") return ws.close();
    if (behavior === "silent_on_assign") {
      silent = true;
      return;
    }
    setTimeout(() => {
      if (ws.readyState !== ws.OPEN) return;
      const started = performance.now();
      let status: "ok" | "error" = "ok", output: string, fatal: boolean | undefined;
      try {
        const input = JSON.parse(msg.input);
        if (msg.module === "sha_chain") output = shaChain(input.seed, input.iterations);
        else if (msg.module === "matmul") output = matmul(input.seed, input.n);
        else {
          status = "error";
          output = "RuntimeError: unreachable";
          fatal = true;
        }
      } catch (e) {
        status = "error";
        output = String(e);
      }
      ws.send(JSON.stringify({
        type: "result", replicaId: msg.replicaId, status, output: output!,
        durationMs: Math.max(0.01, performance.now() - started), impl: "js",
        ...(fatal ? { fatal } : {}),
      }));
    }, opts.delayMs ?? 0);
  });

  return { id, assigns, closed, close: () => ws.close() };
}
