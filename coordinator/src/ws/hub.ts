import type { Server } from "node:http";
import { Ajv } from "ajv";
import { WebSocketServer, type WebSocket } from "ws";
import { readShared } from "../config.ts";
import type { Coordinator, ResultMessage } from "../coordinator.ts";

const ajv = new Ajv();
const validateMessage = ajv.compile(readShared("schemas/messages.v0.schema.json"));

const HELLO_TIMEOUT_MS = 5000;
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

/** Worker WebSocket bağlantılarını (/ws) koordinatöre bağlar; her mesaj ortak şemayla doğrulanır. */
export function attachHub(server: Server, coord: Coordinator): WebSocketServer {
  const wss = new WebSocketServer({ server, path: "/ws", maxPayload: MAX_MESSAGE_BYTES });

  wss.on("connection", (ws: WebSocket) => {
    let workerId: string | null = null;
    const helloTimer = setTimeout(() => ws.close(4001, "hello bekleniyordu"), HELLO_TIMEOUT_MS);

    const reject = (reason: string, detail?: unknown) => {
      coord.db.log("warn", "invalid_message", { workerId, reason, detail });
      ws.close(1008, reason);
    };

    ws.on("message", (data) => {
      let msg: { type?: string; [k: string]: unknown };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return reject("geçersiz JSON");
      }
      if (!validateMessage(msg)) return reject("şemaya uymayan mesaj", { type: (msg as { type?: unknown })?.type });

      if (workerId === null) {
        if (msg.type !== "hello") return reject("ilk mesaj hello olmalı");
        clearTimeout(helloTimer);
        workerId = coord.workerConnected(
          { send: (m) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m)), close: (c, r) => ws.close(c, r) },
          msg as { workerId?: string; userAgent?: string; deviceClass?: string },
        );
        return;
      }
      coord.touch(workerId);
      switch (msg.type) {
        case "result":
          coord.handleResult(workerId, msg as unknown as ResultMessage);
          break;
        case "ping":
          ws.send(JSON.stringify({ type: "pong", t: msg.t ?? Date.now() }));
          break;
        case "status":
          coord.setAvailable(workerId, msg.available === true);
          break;
        case "pong":
          break;
        case "bye":
          ws.close(1000, "bye");
          break;
        case "hello":
          reject("hello yalnızca bir kez gönderilir");
          break;
      }
    });

    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (workerId) coord.workerDisconnected(workerId, "close");
    });
    ws.on("error", () => ws.terminate());
  });

  return wss;
}
