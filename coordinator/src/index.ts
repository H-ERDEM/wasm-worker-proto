import { createServer } from "./server.ts";

// Kullanım: npm run coordinator   (PORT, HOST, DB_PATH ortam değişkenleriyle)
// Telefon gibi aynı ağdaki cihazlar için HOST=0.0.0.0 verin.
const server = await createServer({
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? "127.0.0.1",
  dbPath: process.env.DB_PATH ?? "coordinator.db",
});
console.log(`Koordinatör çalışıyor: ${server.url}  (worker WebSocket: ${server.wsUrl})`);
console.log(`Zamanlayıcı: ${server.coord.scheduler.name}, doğrulayıcı: ${server.coord.verifier.name}`);

const shutdown = async () => {
  await server.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
