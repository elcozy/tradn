/** Disposable test database: created from the migrations on first use, truncated per test file. */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const base = process.env.DATABASE_URL ?? "postgres://trading:trading@localhost:5435/trading";
const testUrl = base.replace(/\/[^/]+$/, "/trading_test");

export async function testDb() {
  const admin = postgres(base, { max: 1, onnotice: () => {} });
  const exists = await admin`SELECT 1 FROM pg_database WHERE datname = 'trading_test'`;
  if (exists.length === 0) await admin.unsafe("CREATE DATABASE trading_test");
  await admin.end();
  const sql = postgres(testUrl, { max: 2, onnotice: () => {} });
  const applied = await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`.then(
    () => sql<{ name: string }[]>`SELECT name FROM schema_migrations`,
  );
  const done = new Set(applied.map((r) => r.name));
  const dir = join(REPO_ROOT, "infra/migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(f)) continue;
    await sql.unsafe(readFileSync(join(dir, f), "utf8"));
    await sql`INSERT INTO schema_migrations (name) VALUES (${f})`;
  }
  await sql`TRUNCATE candles, signals, positions, orders, fills, equity_snapshots, backtest_runs, backtest_trades, risk_events, engine_state, would_have_won`;
  return sql;
}

export class FakeRedis {
  streams = new Map<string, [string, string[]][]>();
  private seq = 0;
  async xadd(key: string, ...args: (string | number)[]) {
    const id = `${Date.now()}-${this.seq++}`;
    const i = args.indexOf("*");
    const fields = args.slice(i + 1).map(String);
    if (!this.streams.has(key)) this.streams.set(key, []);
    this.streams.get(key)!.push([id, fields]);
    return id;
  }
  async xrevrange(key: string, _end: string, _start: string, ...args: (string | number)[]) {
    const count = Number(args[1] ?? 100);
    return [...(this.streams.get(key) ?? [])].reverse().slice(0, count);
  }
  async xread() {
    await new Promise((r) => setTimeout(r, 50));
    return null;
  }
}
