// Elle deneme için: tarayıcı worker'ı hazır olana kadar koordinatöre bağlanan sahte worker.
// Kullanım: node coordinator/test/run-fake-worker.ts [ws://127.0.0.1:8787/ws]
import { startFakeWorker } from "./fake-worker.ts";

const url = process.argv[2] ?? "ws://127.0.0.1:8787/ws";
const w = startFakeWorker(url);
console.log(`Sahte worker bağlandı: ${await w.id}`);
const { code } = await w.closed;
console.log(`Bağlantı kapandı (kod ${code})`);
