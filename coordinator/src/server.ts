import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { loadConfig, type Config } from "./config.ts";
import { Coordinator } from "./coordinator.ts";
import { Db } from "./db/db.ts";
import { httpHandler } from "./api/http.ts";
import { attachHub } from "./ws/hub.ts";

export interface ServerOptions {
  port?: number;
  host?: string;
  dbPath?: string;
  config?: Partial<Config>;
}

export async function createServer(opts: ServerOptions = {}) {
  const db = new Db(opts.dbPath ?? ":memory:");
  const coord = new Coordinator(loadConfig(opts.config), db);
  const http = createHttpServer(httpHandler(coord));
  const wss = attachHub(http, coord);
  await new Promise<void>((resolve) => http.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", resolve));
  coord.start();
  const { port } = http.address() as AddressInfo;
  const host = opts.host && opts.host !== "0.0.0.0" ? opts.host : "127.0.0.1";
  return {
    coord,
    db,
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
