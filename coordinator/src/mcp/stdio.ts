/**
 * MCP sunucusunu stdio üzerinden çalıştırır (Claude masaüstü uygulaması, MCP Inspector).
 *
 *   COORDINATOR_URL=http://127.0.0.1:8787 npm run mcp
 *
 * Koordinatör ayrıca çalışıyor olmalı (npm run coordinator). stdout MCP iletişimine ayrıldığı için
 * günlük stderr'e yazılır.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.ts";

const baseUrl = process.env.COORDINATOR_URL ?? "http://127.0.0.1:8787";
// Araç çağrıları stderr'e yazılır: terminalde görünür, Claude masaüstü sunucu günlüğüne kaydeder.
const server = createMcpServer({ baseUrl, log: (line) => console.error(`${new Date().toISOString()} ${line}`) });
await server.connect(new StdioServerTransport());
console.error(`MCP sunucusu hazır (stdio) → koordinatör ${baseUrl}`);
