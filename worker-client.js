// WorkerClient: Web Worker'ı yönetir, yanıtları taskId ile eşleştirir, fatal hatadan sonra
// worker'ı yeniden başlatır. Hem prototip sayfası (main.js) hem gönüllü sayfası (volunteer.js) kullanır.

export const DEFAULT_TASK_TIMEOUT_MS = 120000;

export class WorkerClient {
  constructor({ timeoutMs = DEFAULT_TASK_TIMEOUT_MS } = {}) {
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.start();
  }

  start() {
    this.worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    this.worker.onmessage = (e) => this.onMessage(e.data);
    this.worker.onerror = (e) => {
      e.preventDefault();
      this.failAll(`worker error: ${e.message || "failed to start (module worker unsupported?)"}`);
    };
  }

  onMessage(msg) {
    if (msg.taskId === null || msg.taskId === undefined) {
      this.failAll(msg.output);
      return;
    }
    const entry = this.pending.get(msg.taskId);
    if (!entry) return;
    this.pending.delete(msg.taskId);
    clearTimeout(entry.timer);
    entry.resolve(msg);
    if (msg.fatal) this.restart();
  }

  failAll(reason) {
    for (const [taskId, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({ taskId, status: "error", output: reason, durationMs: 0 });
    }
    this.pending.clear();
    this.restart();
  }

  restart() {
    this.worker.terminate();
    this.start();
  }

  run(module, input, impl = "wasm", timeoutMs = this.timeoutMs) {
    const taskId = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(taskId);
        this.restart();
        resolve({ taskId, status: "error", output: `timeout after ${timeoutMs} ms`, durationMs: 0 });
      }, timeoutMs);
      this.pending.set(taskId, { resolve, timer });
      this.worker.postMessage({ taskId, module, input, impl });
    });
  }
}
