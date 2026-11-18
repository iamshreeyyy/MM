import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';

const [action, sku, price, stock] = process.argv.slice(2);
const path = process.env.DATABASE_PATH || (process.env.RAZORPAY_KEY_ID ? 'munchmillet.sqlite' : 'demo.sqlite');
if (!existsSync(path)) throw Error('Start the shop once to initialize the database.');
const db = new DatabaseSync(path);
db.exec('PRAGMA busy_timeout=5000');
try {
  if (action === 'inventory') {
    console.table(db.prepare('SELECT sku,price AS price_paise,available FROM inventory ORDER BY sku').all());
  } else if (action === 'review') {
    console.table(db.prepare("SELECT id,sku,qty,amount AS amount_paise,payment_id FROM orders WHERE status='review'").all());
  } else if (action === 'set') {
    const amount = Number(price);
    const available = Number(stock);
    if (!/^\d+$/.test(price || '') || !/^\d+$/.test(stock || '') ||
        !Number.isSafeInteger(amount) || amount < 1 || amount > 10_000_000 || !Number.isSafeInteger(available)) {
      throw Error('Use: set SKU PRICE_PAISE AVAILABLE_UNRESERVED_UNITS');
    }
    const result = db.prepare('UPDATE inventory SET price=?,available=?,revision=revision+1 WHERE sku=?').run(amount,available,sku);
    if (!result.changes) throw Error('Unknown SKU.');
    console.log('Inventory updated for', sku);
  } else {
    throw Error('Use inventory, review, or set SKU PRICE_PAISE AVAILABLE_UNRESERVED_UNITS.');
  }
} finally {
  db.close();
}
