import { DatabaseSync } from "node:sqlite";

/**
 * Olay kaydı. `replicas` tablosunun sütunları simülatörün olay kaydıyla aynıdır
 * (docs/ROADMAP.md, kural 3). Zamanlar Unix ms.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS workers (
  id TEXT PRIMARY KEY, user_agent TEXT, device_class TEXT,
  first_seen INTEGER, last_seen INTEGER,
  alpha REAL DEFAULT 0, beta REAL DEFAULT 0, speed_ema REAL, wallet TEXT
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, dag_json TEXT NOT NULL,
  strategy_sched TEXT, strategy_verif TEXT, status TEXT,
  submitted_at INTEGER, completed_at INTEGER,
  quote_cap REAL, payment_tx TEXT, refund_tx TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL, dag_task_id TEXT NOT NULL,
  module TEXT, input_resolved TEXT, cost REAL, state TEXT,
  accepted_output TEXT, ready_at INTEGER, accepted_at INTEGER
);
CREATE TABLE IF NOT EXISTS replicas (
  id INTEGER PRIMARY KEY, task_id TEXT NOT NULL, worker_id TEXT,
  is_spotcheck INTEGER DEFAULT 0, expected_output TEXT, state TEXT,
  created_at INTEGER, assigned_at INTEGER, deadline_at INTEGER, returned_at INTEGER,
  output TEXT, duration_ms REAL, load_ms REAL, fatal INTEGER, paid INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS log (
  t INTEGER, level TEXT, event TEXT, detail TEXT
);
CREATE INDEX IF NOT EXISTS replicas_task ON replicas(task_id);
`;

export type Row = Record<string, string | number | null>;

export class Db {
  readonly raw: DatabaseSync;
  constructor(path = ":memory:") {
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA journal_mode = WAL;");
    this.raw.exec(SCHEMA);
  }

  insert(table: string, row: Row): void {
    const cols = Object.keys(row);
    this.raw
      .prepare(`INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
      .run(...cols.map((c) => row[c]));
  }

  update(table: string, id: string | number, row: Row): void {
    const cols = Object.keys(row);
    this.raw
      .prepare(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(",")} WHERE id = ?`)
      .run(...cols.map((c) => row[c]), id);
  }

  upsertWorker(row: Row & { id: string }): void {
    const exists = this.raw.prepare("SELECT 1 FROM workers WHERE id = ?").get(row.id);
    if (exists) {
      const { id, first_seen: _f, ...rest } = row;
      this.update("workers", id, rest);
    } else this.insert("workers", row);
  }

  all(sql: string, ...params: (string | number)[]): Row[] {
    return this.raw.prepare(sql).all(...params) as Row[];
  }

  log(level: "info" | "warn" | "error", event: string, detail: unknown = null): void {
    this.insert("log", { t: Date.now(), level, event, detail: detail == null ? null : JSON.stringify(detail) });
  }

  close(): void {
    this.raw.close();
  }
}
