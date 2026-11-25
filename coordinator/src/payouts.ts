/**
 * Worker ödemeleri ve alıcı iadesi (10. hafta, ROADMAP Aşama 9).
 *
 * İş bitip geç dönen sınama işleri de sonuçlanınca koordinatör bir ödeme planı çıkarır
 * (Coordinator.payoutPlan): her worker'a doğrulanmış kopyaları ve geçtiği sınama işleri kadar birim
 * ücret, alıcıya da üst sınırla gerçekleşen maliyet arasındaki fark. Bu modül planı `payouts`
 * tablosuna yazar ve zincire gönderir.
 *
 * Çift ödemeye karşı üç katman:
 *  1. (job_id, kind, payee) tekil: plan ikinci kez yazılamaz (INSERT OR IGNORE).
 *  2. İşlem imzalanınca imza ve blok karması, yayınlanmadan ÖNCE yazılır (status = sent). Süreç çökse
 *     bile yeniden başlatmada aynı imza sorgulanır; o imza zincirde varsa ya da hâlâ geçerliyse
 *     yeniden imzalanmaz.
 *  3. Yalnızca zincirde hiç yer almadığı kesinleşen (blok karması süresi dolmuş) işlem yeniden
 *     imzalanır; zincirde hata veren işlem `failed` olur ve sınırlı sayıda yeniden denenir.
 *
 * Zincir erişimi Chain arayüzünün arkasındadır: gerçek ortamda Solana Devnet (solana-chain.ts),
 * testlerde sahte zincir. Zincir yoksa (PAYOUTS kapalı) plan yazılır, gönderim beklemede kalır.
 */
import type { Db } from "./db/db.ts";

export interface Transfer {
  /** Alıcının cüzdan adresi (sahip); token hesabı zincir tarafında türetilir. */
  to: string;
  amountAtomic: number;
}

export interface SignedBatch {
  signature: string;
  blockhash: string;
  lastValidBlockHeight: number;
  /** İmzalı işlemi yayınlar. Hata fırlatabilir; o durumda durum sorgusu karar verir. */
  send(): Promise<void>;
}

export type ChainStatus = "confirmed" | "failed" | "pending" | "expired";

export interface Chain {
  /** Platform cüzdanından tek işlemde toplu transfer; alıcının token hesabı yoksa açılır. */
  sign(transfers: Transfer[]): Promise<SignedBatch>;
  /** confirmed: zincirde başarılı; failed: zincirde hata; pending: henüz bilinmiyor, karma geçerli; expired: zincirde yok ve artık giremez. */
  status(signature: string, lastValidBlockHeight: number): Promise<{ status: ChainStatus; error?: string }>;
}

export interface PlanEntry {
  kind: "worker" | "refund";
  payee: string;
  recipient: string | null;
  units: number | null;
  amountAtomic: number;
}

export interface PayoutOptions {
  /** Tek işlemdeki en fazla transfer (Solana işlem boyutu sınırı; ATA açma talimatıyla birlikte). */
  batchSize?: number;
  maxAttempts?: number;
  /** Onay beklerken sorgu aralığı (ms). */
  pollMs?: number;
}

export class PayoutService {
  readonly db: Db;
  readonly chain: Chain | null;
  readonly batchSize: number;
  readonly maxAttempts: number;
  readonly pollMs: number;
  /** Aynı anda yalnızca bir gönderim turu çalışır (aynı satırın iki kez imzalanmaması için). */
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = false;

  constructor(db: Db, chain: Chain | null, opts: PayoutOptions = {}) {
    this.db = db;
    this.chain = chain;
    this.batchSize = opts.batchSize ?? 8;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.pollMs = opts.pollMs ?? 2000;
  }

  /** Planı yazar; daha önce yazılmışsa hiçbir şey değişmez. Yazılan satır sayısını döndürür. */
  plan(jobId: string, entries: PlanEntry[]): number {
    const now = Date.now();
    let n = 0;
    for (const e of entries) {
      if (e.amountAtomic <= 0) continue;
      const status = e.recipient ? "pending" : "no_wallet";
      n += this.db.run(
        `INSERT OR IGNORE INTO payouts (job_id, kind, payee, recipient, units, amount_atomic, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        jobId, e.kind, e.payee, e.recipient, e.units, e.amountAtomic, status, now, now,
      );
    }
    if (n > 0) this.db.log("info", "payouts_planned", { jobId, rows: n, chain: this.chain ? "on" : "off" });
    this.kick();
    return n;
  }

  /** Bir gönderim turunu başlatır (çalışıyorsa bittiğinde bir tur daha). Tur bitince çözülür. */
  kick(): Promise<void> {
    if (!this.chain || this.stopped) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        try {
          await this.round();
        } catch (e) {
          this.db.log("error", "payout_round_failed", { error: String(e) });
        }
      } while (this.again && !this.stopped);
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  stop(): void {
    this.stopped = true;
  }

  private rows(where: string, ...p: (string | number)[]) {
    return this.db.all(`SELECT * FROM payouts WHERE ${where} ORDER BY id`, ...p) as unknown as PayoutRow[];
  }

  private set(ids: number[], fields: Record<string, string | number | null>) {
    for (const id of ids) this.db.update("payouts", id, { ...fields, updated_at: Date.now() });
  }

  /** Önce yayınlanmış ama sonucu bilinmeyen işlemler, sonra bekleyenler. */
  private async round(): Promise<void> {
    const chain = this.chain!;
    // 1) Yarım kalmış işlemler (çökme ya da önceki tur): imzaları sorgulanır.
    const sent = this.rows("status = 'sent'");
    for (const sig of [...new Set(sent.map((r) => r.tx_signature!))]) {
      const group = sent.filter((r) => r.tx_signature === sig);
      await this.settle(group, sig, group[0].last_valid_height ?? 0);
    }
    // 2) Bekleyenler: gruplar hâlinde imzala → kaydet → yayınla → sonuçlanana kadar sorgula.
    for (;;) {
      if (this.stopped) return;
      const pending = this.rows("status = 'pending' AND attempts < ?", this.maxAttempts).slice(0, this.batchSize);
      if (!pending.length) return;
      const ids = pending.map((r) => r.id);
      let batch: SignedBatch;
      try {
        batch = await chain.sign(pending.map((r) => ({ to: r.recipient!, amountAtomic: r.amount_atomic })));
      } catch (e) {
        this.set(ids, { attempts: pending[0].attempts + 1, error: `imzalanamadı: ${String(e)}` });
        this.db.log("error", "payout_sign_failed", { ids, error: String(e) });
        continue;
      }
      // İmza, yayınlanmadan önce kaydedilir: buradan sonra aynı satırlar yeni bir işlemle ödenmez.
      for (const r of pending) {
        this.db.update("payouts", r.id, {
          status: "sent", tx_signature: batch.signature, blockhash: batch.blockhash,
          last_valid_height: batch.lastValidBlockHeight, attempts: r.attempts + 1, error: null, updated_at: Date.now(),
        });
      }
      this.db.log("info", "payout_sent", { ids, signature: batch.signature, total: pending.reduce((n, r) => n + r.amount_atomic, 0) });
      try {
        await batch.send();
      } catch (e) {
        // Yayın hatası işlemin zincire girmediği anlamına gelmez (ör. zaman aşımı); karar durum sorgusunun.
        this.db.log("warn", "payout_send_error", { signature: batch.signature, error: String(e) });
      }
      await this.settle(this.rows(`id IN (${ids.join(",")})`), batch.signature, batch.lastValidBlockHeight);
    }
  }

  private async settle(group: PayoutRow[], signature: string, lastValid: number): Promise<void> {
    const ids = group.map((r) => r.id);
    for (;;) {
      const st = await this.chain!.status(signature, lastValid);
      if (st.status === "confirmed") {
        this.set(ids, { status: "confirmed", error: null });
        this.db.log("info", "payout_confirmed", { ids, signature });
        this.markRefund(group, signature);
        return;
      }
      if (st.status === "failed" || st.status === "expired") {
        // Zincirde hata ya da hiç girmedi: yeniden denenebilir (deneme sınırına kadar).
        const retry = group[0].attempts < this.maxAttempts;
        this.set(ids, { status: retry ? "pending" : "failed", tx_signature: null, error: `${st.status}${st.error ? `: ${st.error}` : ""}` });
        this.db.log("warn", "payout_failed", { ids, signature, status: st.status, error: st.error ?? null, retry });
        return;
      }
      if (this.stopped) return;
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
  }

  private markRefund(group: PayoutRow[], signature: string) {
    for (const r of group) if (r.kind === "refund") this.db.update("jobs", r.job_id, { refund_tx: signature });
  }

  /** İşin ödemeleri (API ve panel için). */
  forJob(jobId: string) {
    return this.rows("job_id = ?", jobId).map((r) => ({
      kind: r.kind, payee: r.payee, recipient: r.recipient, units: r.units, amountAtomic: r.amount_atomic,
      status: r.status, transaction: r.tx_signature, error: r.error,
    }));
  }
}

interface PayoutRow {
  id: number;
  job_id: string;
  kind: "worker" | "refund";
  payee: string;
  recipient: string | null;
  units: number | null;
  amount_atomic: number;
  status: string;
  tx_signature: string | null;
  blockhash: string | null;
  last_valid_height: number | null;
  attempts: number;
  error: string | null;
}
