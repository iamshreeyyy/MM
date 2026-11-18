import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export const catalog = JSON.parse(readFileSync(new URL('./catalog.json', import.meta.url)));
const holdMs = 15 * 60_000;

export function openStore(path, stock, now = Date.now) {
  const db = new DatabaseSync(path);
  db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const transaction = (operation) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  for (const item of catalog) {
    run('INSERT OR IGNORE INTO inventory(sku,price,available) VALUES(?,?,?)', item.sku, item.price, stock);
  }
  function queue(id, kind, payload) {
    run('INSERT OR IGNORE INTO jobs(id,kind,payload,run_after) VALUES(?,?,?,?)',
      id, kind, JSON.stringify(payload), now());
  }
  function decrease(sku, qty) {
    return run('UPDATE inventory SET available=available-?, revision=revision+1 WHERE sku=? AND available>=?', qty, sku, qty).changes > 0;
  }
  function release(order) {
    run("UPDATE orders SET status='expired' WHERE id=?", order.id);
    run('UPDATE inventory SET available=available+?, revision=revision+1 WHERE sku=?', order.qty, order.sku);
  }

  return {
    close: () => db.close(),
    inventory: () => all('SELECT * FROM inventory'),
    order: id => get('SELECT * FROM orders WHERE id=?', id),
    reserve(sku, qty, customer) {
      return transaction(() => {
        const item = get('SELECT price FROM inventory WHERE sku=?', sku);
        if (!item || !decrease(sku, qty)) return null;
        const order = { id: randomUUID(), amount: item.price * qty, expires: now() + holdMs };
        run("INSERT INTO orders(id,sku,qty,amount,customer,status,expires) VALUES(?,?,?,?,?,'pending',?)",
          order.id, sku, qty, order.amount, JSON.stringify(customer), order.expires);
        return order;
      });
    },
    attach(id, providerOrder) {
      return run("UPDATE orders SET provider_order=? WHERE id=? AND status='pending' AND expires>?", providerOrder, id, now()).changes > 0;
    },
    abandon(id) {
      return transaction(() => {
        const order = get("SELECT * FROM orders WHERE id=? AND status='pending' AND provider_order IS NULL", id);
        if (order) release(order);
      });
    },
    expire() {
      return transaction(() => {
        const orders = all(`
          SELECT * FROM orders WHERE status='pending' AND expires<=?
          AND NOT EXISTS (
            SELECT 1 FROM jobs WHERE kind='payment' AND done=0
            AND json_extract(payload,'$.order_id')=orders.provider_order
          )
          LIMIT 100`, now());
        orders.forEach(release);
        return orders.length;
      });
    },
    enqueuePayment(payment) {
      return transaction(() => {
        const order = get('SELECT * FROM orders WHERE provider_order=?', payment.order_id);
        if (!order || order.amount !== payment.amount || payment.currency !== 'INR') return false;
        queue('payment:' + payment.id, 'payment', payment);
        return true;
      });
    },
    applyPayment(job) {
      return transaction(() => {
        const payment = job.payload;
        const order = get('SELECT * FROM orders WHERE provider_order=?', payment.order_id);
        if (order.status === 'pending' || order.status === 'expired') {
          const fulfilled = order.status === 'pending' || decrease(order.sku, order.qty);
          run('UPDATE orders SET status=?,payment_id=? WHERE id=?', fulfilled ? 'paid' : 'review', payment.id, order.id);
          queue('email:' + order.id, 'email', { id: order.id });
        }
        run('UPDATE jobs SET done=1 WHERE id=?', job.id);
      });
    },
    claim() {
      return transaction(() => {
        const job = get('SELECT * FROM jobs WHERE done=0 AND run_after<=? ORDER BY run_after,id LIMIT 1', now());
        if (!job) return null;
        run('UPDATE jobs SET run_after=?, attempts=attempts+1 WHERE id=?', now() + 120_000, job.id);
        return { ...job, payload: JSON.parse(job.payload) };
      });
    },
    finish: id => run('UPDATE jobs SET done=1 WHERE id=?', id),
    retry: job => run('UPDATE jobs SET run_after=? WHERE id=? AND done=0', now() + Math.min(300_000, 2000 * 2 ** Math.min(job.attempts, 8)), job.id)
  };
}

