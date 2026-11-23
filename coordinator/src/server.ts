import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { loadConfig, type Config } from "./config.ts";
import { Coordinator } from "./coordinator.ts";
import { Db } from "./db/db.ts";
import { httpHandler } from "./api/http.ts";
import { attachHub } from "./ws/hub.ts";
import { bundleHash, DEFAULT_WASM_PATH } from "./modules.ts";
import { loadOracle, type Oracle } from "./oracle.ts";
import { JobPayments, type PaymentOptions } from "./api/payments.ts";

export interface ServerOptions {
  port?: number;
  host?: string;
  dbPath?: string;
  config?: Partial<Config>;
  /** WASM paketi; varsayılan pkg/vc_tasks_bg.wasm. Özeti başlangıçta bir kez hesaplanır. */
  wasmPath?: string;
  /** Sınama işi kâhini; varsayılan: pkg/ derlenmişse Node'da WASM, değilse saf JS. */
  oracle?: Oracle;
  /** [0, 1) rastgele sayı üreteci (testler için). */
  random?: () => number;
  /** Verilirse POST /jobs x402 ödemesinin arkasına alınır (Devnet USDC, üst sınır). */
  payments?: PaymentOptions;
}

export async function createServer(opts: ServerOptions = {}) {
  const db = new Db(opts.dbPath ?? ":memory:");
  const coord = new Coordinator(loadConfig(opts.config), db, {
    wasmHash: bundleHash(opts.wasmPath ?? DEFAULT_WASM_PATH),
    oracle: opts.oracle ?? (await loadOracle()),
    random: opts.random,
  });
  let payments: JobPayments | null = null;
  if (opts.payments) {
    payments = new JobPayments(coord, opts.payments);
    await payments.initialize(); // facilitator erişilemezse burada hata verir
  }
  const http = createHttpServer(httpHandler(coord, payments));
  const wss = attachHub(http, coord);
  await new Promise<void>((resolve) => http.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", resolve));
  coord.start();
  const { port } = http.address() as AddressInfo;
  const host = opts.host && opts.host !== "0.0.0.0" ? opts.host : "127.0.0.1";
  return {
    coord,
    db,
    payments,
    wss,
    url: `http://${host}:${port}`,
    wsUrl: `ws://${host}:${port}/ws`,
    async close() {
      coord.stop();
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
      db.close();
    },
  };
}
