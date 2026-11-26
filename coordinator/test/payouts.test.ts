/**
 * 10.1: worker ödemeleri ve iade. Gönderim mantığı sahte zincirle (ağ gerektirmez); Solana
 * işleminin kurulması sahte RPC ile ağsız imzalanarak denetlenir. Devnet'te gerçek gönderim elle.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { getBase64Encoder, getTransactionDecoder, getCompiledTransactionMessageDecoder } from "@solana/kit";
import { Db } from "../src/db/db.ts";
import { PayoutService, type Chain, type ChainStatus, type Transfer } from "../src/payouts.ts";
import { solanaChain } from "../src/solana-chain.ts";

const A = "FKqFgXvXGih6KDYsLSLNAk5WrANM68ZfgkfGUWmEeyrF";
const B = "8fG4mWUr2cMrcVrMRD1pSodKSffekd5a4Zj7EBm5XiiY";
const C = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

type Script = { send?: "ok" | "throw" | "throw_lost"; result?: ChainStatus[] };

/** Sahte zincir: her imzalanan işlem için senaryodaki sıradaki davranış. */
class FakeChain implements Chain {
  signed: { signature: string; transfers: Transfer[] }[] = [];
  sent: string[] = [];
  private scripts: Script[];
  private plan = new Map<string, ChainStatus[]>();
  signThrows = 0;
  constructor(scripts: Script[] = []) {
    this.scripts = scripts;
  }
  async sign(transfers: Transfer[]) {
    if (this.signThrows > 0) {
      this.signThrows--;
      throw new Error("RPC erişilemiyor");
    }
    const n = this.signed.length;
    const sc = this.scripts[n] ?? {};
    const signature = `SIG${n + 1}`;
    this.signed.push({ signature, transfers });
    this.plan.set(signature, [...(sc.result ?? ["confirmed"])]);
    return {
      signature, blockhash: `BH${n + 1}`, lastValidBlockHeight: 100,
      send: async () => {
        this.sent.push(signature);
        if (sc.send === "throw" || sc.send === "throw_lost") throw new Error("yayın zaman aşımı");
      },
    };
  }
  async status(signature: string) {
    const q = this.plan.get(signature) ?? ["expired"];
    const st = q.length > 1 ? q.shift()! : q[0];
    return st === "failed" ? { status: st, error: "InstructionError" } : { status: st };
  }
}

function setup(chain: Chain | null, opts = {}) {
  const db = new Db(":memory:");
  db.insert("jobs", { id: "job_1", dag_json: "{}", status: "COMPLETED", quote_cap: 77778, payer: C, realized_cost: 15000, refund_due: 62778 });
  return { db, svc: new PayoutService(db, chain, { pollMs: 1, ...opts }) };
}
const plan1 = [
  { kind: "worker" as const, payee: "w_a", recipient: A, units: 8, amountAtomic: 8000 },
  { kind: "worker" as const, payee: "w_b", recipient: B, units: 6, amountAtomic: 6000 },
  { kind: "worker" as const, payee: "w_x", recipient: null, units: 1, amountAtomic: 1000 },
  { kind: "refund" as const, payee: "payer", recipient: C, units: null, amountAtomic: 62778 },
];
const rows = (db: Db) => db.all("SELECT payee, status, amount_atomic, tx_signature, attempts FROM payouts ORDER BY id").map((r) => ({ ...r }));

test("plan bir kez yazılır; toplam üst sınıra eşit; adresi olmayan worker 'no_wallet'", async () => {
  const chain = new FakeChain();
  const { db, svc } = setup(chain);
  assert.equal(svc.plan("job_1", plan1), 4);
  assert.equal(svc.plan("job_1", plan1), 0, "ikinci plan hiçbir satır eklemez");
  await svc.kick();
  assert.equal(Number(db.all("SELECT SUM(amount_atomic) AS s FROM payouts")[0].s), 77778);
  assert.deepEqual(rows(db).map((r) => [r.payee, r.status]), [["w_a", "confirmed"], ["w_b", "confirmed"], ["w_x", "no_wallet"], ["payer", "confirmed"]]);
  assert.equal(chain.signed.length, 1, "tek işlem");
  assert.deepEqual(chain.signed[0].transfers, [{ to: A, amountAtomic: 8000 }, { to: B, amountAtomic: 6000 }, { to: C, amountAtomic: 62778 }]);
  assert.equal(db.all("SELECT refund_tx FROM jobs")[0].refund_tx, "SIG1");
});

test("zincir kapalıyken plan yazılır, gönderim beklemede kalır", async () => {
  const { db, svc } = setup(null);
  svc.plan("job_1", plan1);
  await svc.kick();
  assert.deepEqual(rows(db).map((r) => r.status), ["pending", "pending", "no_wallet", "pending"]);
});

test("toplu gönderim: işlem başına en fazla batchSize transfer", async () => {
  const chain = new FakeChain();
  const { db, svc } = setup(chain, { batchSize: 2 });
  svc.plan("job_1", plan1);
  await svc.kick();
  assert.deepEqual(chain.signed.map((b) => b.transfers.length), [2, 1]);
  assert.ok(rows(db).filter((r) => r.payee !== "w_x").every((r) => r.status === "confirmed"));
});

test("zincirde hata veren işlem yeniden imzalanıp gönderilir; ikinci deneme başarılı", async () => {
  const chain = new FakeChain([{ result: ["failed"] }, {}]);
  const { db, svc } = setup(chain);
  svc.plan("job_1", plan1);
  await svc.kick();
  assert.equal(chain.signed.length, 2);
  const r = rows(db).filter((x) => x.payee !== "w_x");
  assert.ok(r.every((x) => x.status === "confirmed" && x.tx_signature === "SIG2" && x.attempts === 2));
});

test("çift ödeme yok: yayın hata verse de işlem zincire girdiyse yeniden imzalanmaz", async () => {
  const chain = new FakeChain([{ send: "throw", result: ["pending", "confirmed"] }]);
  const { db, svc } = setup(chain);
  svc.plan("job_1", plan1);
  await svc.kick();
  assert.equal(chain.signed.length, 1, "yalnızca bir işlem imzalandı");
  assert.ok(rows(db).filter((x) => x.payee !== "w_x").every((x) => x.status === "confirmed" && x.tx_signature === "SIG1"));
});

test("zincire hiç girmeyen işlem (karma süresi doldu) yeniden imzalanır", async () => {
  const chain = new FakeChain([{ send: "throw_lost", result: ["pending", "expired"] }, {}]);
  const { db, svc } = setup(chain);
  svc.plan("job_1", plan1);
  await svc.kick();
  assert.equal(chain.signed.length, 2);
  assert.ok(rows(db).filter((x) => x.payee !== "w_x").every((x) => x.status === "confirmed" && x.tx_signature === "SIG2"));
});

test("deneme sınırı: hep başarısız olan transfer 'failed' kalır", async () => {
  const chain = new FakeChain([{ result: ["failed"] }, { result: ["failed"] }, { result: ["failed"] }]);
  const { db, svc } = setup(chain, { maxAttempts: 3 });
  svc.plan("job_1", plan1);
  await svc.kick();
  assert.equal(chain.signed.length, 3);
  assert.ok(rows(db).filter((x) => x.payee !== "w_x").every((x) => x.status === "failed" && x.attempts === 3));
});

test("imzalama hatası (RPC yok) sayılır ve sonraki turda yeniden denenir", async () => {
  const chain = new FakeChain();
  chain.signThrows = 1;
  const { db, svc } = setup(chain);
  svc.plan("job_1", plan1);
  await svc.kick();
  assert.ok(rows(db).filter((x) => x.payee !== "w_x").every((x) => x.status === "confirmed"));
  assert.equal(chain.signed.length, 1);
});

test("yeniden başlatmada kurtarma: 'sent' satırlar aynı imzayla sorgulanır, yeniden imzalanmaz", async () => {
  const first = new FakeChain([{ result: ["pending"] }]);
  const { db, svc } = setup(first);
  svc.plan("job_1", plan1);
  const running = svc.kick();
  await new Promise((r) => setTimeout(r, 20));
  svc.stop(); // süreç "çöktü": işlem yayınlandı, sonuç bilinmiyor
  await running;
  assert.ok(rows(db).filter((x) => x.payee !== "w_x").every((x) => x.status === "sent" && x.tx_signature === "SIG1"));

  const second: Chain & { asked: string[] } = {
    asked: [],
    async sign() { throw new Error("yeniden imzalanmamalı"); },
    async status(sig) { this.asked.push(sig); return { status: "confirmed" }; },
  };
  const svc2 = new PayoutService(db, second, { pollMs: 1 });
  await svc2.kick();
  assert.deepEqual(second.asked, ["SIG1"]);
  assert.ok(rows(db).filter((x) => x.payee !== "w_x").every((x) => x.status === "confirmed"));
});

test("eşzamanlı tetikleme tek gönderim turu çalıştırır", async () => {
  const chain = new FakeChain();
  const { svc } = setup(chain);
  svc.plan("job_1", plan1);
  await Promise.all([svc.kick(), svc.kick(), svc.kick()]);
  assert.equal(chain.signed.length, 1);
});

test("Solana işlemi ağsız kurulur: alıcı başına token hesabı açma + TransferChecked, ücreti platform öder", async () => {
  const platformSecret = "4Z7cXSyeFR8wNGMVXUE1TwtKn5D5Vu7FzEv69dokLv7KrQk7h6pu4LF8ZRR9yQBhc7uSM6RTTZtU1fmaxiNrxXrs";
  const fakeRpc = {
    getLatestBlockhash: () => ({ send: async () => ({ value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 123n } }) }),
  };
  const chain = await solanaChain({ rpcUrl: "", platformSecret, mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", rpc: fakeRpc as never });
  const b = await chain.sign([{ to: A, amountAtomic: 8000 }, { to: C, amountAtomic: 62778 }]);
  assert.equal(b.lastValidBlockHeight, 123);
  assert.match(b.signature, /^[1-9A-HJ-NP-Za-km-z]{80,90}$/);
  // İmzalı işlemi çözüp talimatları say: 2 alıcı × (ATA idempotent + TransferChecked) = 4.
  let wire = "";
  const rpcSend = { sendTransaction: (w: string) => ({ send: async () => { wire = w; } }) };
  const chain2 = await solanaChain({ rpcUrl: "", platformSecret, mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", rpc: { ...fakeRpc, ...rpcSend } as never });
  await (await chain2.sign([{ to: A, amountAtomic: 8000 }, { to: C, amountAtomic: 62778 }])).send();
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
  const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes) as unknown as { instructions: unknown[]; staticAccounts: string[] };
  assert.equal(msg.instructions.length, 4);
  assert.equal(msg.staticAccounts[0], chain2.address, "ücreti platform öder");
});
