PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS inventory (
  sku TEXT PRIMARY KEY, price INTEGER NOT NULL CHECK(price > 0),
  available INTEGER NOT NULL CHECK(available >= 0), revision INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, sku TEXT NOT NULL REFERENCES inventory, qty INTEGER NOT NULL,
  amount INTEGER NOT NULL, customer TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','expired','paid','review')),
  expires INTEGER NOT NULL, provider_order TEXT UNIQUE, payment_id TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS pending_expiry ON orders (expires) WHERE status='pending';
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL,
  run_after INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS scheduled_jobs ON jobs (run_after) WHERE done=0;
