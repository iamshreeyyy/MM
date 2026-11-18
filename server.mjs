import { createServer } from 'node:http';
import { access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { capturedPayment, razorpay, sign } from './payments.mjs';
import { catalog, openStore } from './store.mjs';

const files = new Map([
  ['/', ['index.html','text/html; charset=utf-8']],
  ['/style.css', ['style.css','text/css; charset=utf-8']],
  ['/app.js', ['app.js','text/javascript; charset=utf-8']],
  ['/lineup.png', ['lineup.png','image/png']],
]);

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function rawBody(request) {
  if (Number(request.headers['content-length']) > 128_000) throw new RequestError(413, 'Request too large.');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 128_000) throw new RequestError(413, 'Request too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function cleanOrder(body) {
  const { sku, qty } = body || {};
  const customer = {};
  for (const [key, max] of [['name',100],['email',254],['phone',20],['address',500],['pin',6]]) {
    const value = body?.customer?.[key];
    if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new RequestError(400, 'Please enter valid delivery and contact details.');
    }
    customer[key] = value.trim();
  }
  if (!catalog.some(item => item.sku === sku) || !Number.isInteger(qty) || qty < 1 || qty > 10 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email) || !/^\+?[\d -]{10,16}$/.test(customer.phone) ||
      !/^[1-9]\d{5}$/.test(customer.pin)) {
    throw new RequestError(400, 'Check the product, quantity, email, phone, and delivery PIN.');
  }
  return { sku, qty, customer };
}

export function createShop({ store, provider, secret, key, mode, mail, cache, onError = console.error }) {
  const hasPhoto = access(new URL('./public/lineup.png', import.meta.url)).then(() => true, () => false);
  let working = false;
  function cacheCall(promise) {
    return promise.catch(() => undefined);
  }
  const refresh = () => cache && cacheCall(cache.write(store.inventory()));
  async function stock() {
    const cached = cache && await cacheCall(cache.read());
    if (cached?.length === catalog.length) return cached;
    const rows = store.inventory();
    if (cache) await cacheCall(cache.write(rows));
    return rows;
  }
  function accept(body, signature) {
    const payment = capturedPayment(body, signature, secret);
    if (payment === false) return;
    if (!payment) throw new RequestError(401, 'Invalid webhook.');
    if (!store.enqueuePayment(payment)) throw new RequestError(422, 'Unknown order or payment amount mismatch.');
  }
  async function tick() {
    if (working) return;
    working = true;
    try {
      if (store.expire()) await refresh();
      for (let i = 0; i < 20; i++) {
        const job = store.claim();
        if (!job) break;
        try {
          if (job.kind === 'payment') {
            store.applyPayment(job);
            await refresh();
          } else {
            const order = store.order(job.payload.id);
            const item = catalog.find(product => product.sku === order.sku);
            await mail(order, item);
            store.finish(job.id);
          }
        } catch (error) {
          store.retry(job);
          onError(error);
        }
      }
    } finally {
      working = false;
    }
  }

  const server = createServer(async (request, response) => {
    const send = (code, data) => {
      response.writeHead(code, { 'content-type':'application/json', 'cache-control':'no-store' });
      response.end(JSON.stringify(data));
    };
    response.setHeader('x-content-type-options', 'nosniff');
    try {
      const path = new URL(request.url, 'http://localhost').pathname;
      const method = request.method;
      if (method === 'GET' && path === '/api/catalog') {
        const available = await stock();
        return send(200, { mode, hasPhoto:await hasPhoto, products: catalog.map(item => ({ ...item, ...available.find(row => row.sku === item.sku) })) });
      }
      if (method === 'POST' && path === '/api/checkout') {
        const { sku, qty, customer } = cleanOrder(JSON.parse(await rawBody(request)));
        const order = store.reserve(sku, qty, customer);
        if (!order) throw new RequestError(409, 'This quantity is no longer available.');
        void refresh();
        let providerOrder;
        try {
          providerOrder = await provider(order);
          if (!store.attach(order.id, providerOrder)) throw new Error('Reservation expired.');
        } catch (error) {
          store.abandon(order.id);
          void refresh();
          onError(error);
          throw new RequestError(503, 'Checkout could not start. Please try again.');
        }
        return send(201, { ...order, providerOrder, key, mode });
      }
      if (method === 'POST' && path === '/api/webhooks/razorpay' && mode !== 'demo') {
        accept(await rawBody(request), request.headers['x-razorpay-signature']);
        return send(200, { received: true });
      }
      const match = path.match(/^\/api\/orders\/([a-f0-9-]{36})(\/demo-pay)?$/);
      if (match && (method === 'GET' && !match[2] || method === 'POST' && match[2] && mode === 'demo')) {
        const order = store.order(match[1]);
        if (!order) throw new RequestError(404, 'Order unavailable.');
        if (match[2]) {
          const body = Buffer.from(JSON.stringify({ event:'payment.captured', payload:{ payment:{ entity:{
            id:'demo_pay_' + order.id, order_id:order.provider_order, amount:order.amount, currency:'INR', status:'captured'
          } } } }));
          accept(body, sign(body, secret));
          return send(202, { received: true });
        }
        return send(200, { id:order.id, status:order.status, amount:order.amount });
      }
      if (method === 'GET' && files.has(path)) {
        const [file, type] = files.get(path);
        let bytes;
        try {
          bytes = await readFile(new URL('./public/' + file, import.meta.url));
        } catch (error) {
          if (error.code === 'ENOENT') throw new RequestError(404, 'File unavailable.');
          throw error;
        }
        response.writeHead(200, { 'content-type':type });
        return response.end(bytes);
      }
      send(404, { error:'Page unavailable.' });
    } catch (error) {
      if (!error.status && !(error instanceof SyntaxError)) onError(error);
      const code = error.status || (error instanceof SyntaxError ? 400 : 500);
      send(code, { error: code === 500 ? 'Please try again shortly.' : error.status ? error.message : 'Invalid request.' });
    }
  });
  return { server, tick };
}

async function redisCache(url) {
  const { createClient } = await import('redis');
  const client = createClient({ url, disableOfflineQueue:true, socket:{ connectTimeout:2000, reconnectStrategy:false } });
  client.on('error', error => console.error('Redis:', error.message));
  await client.connect();
  const prefix = 'munchmillet:inventory:v1:';
  const keys = catalog.map(item => prefix + item.sku);
  const lua = `
    local cached = redis.call('GET', KEYS[1])
    if not cached or cjson.decode(cached).revision <= tonumber(ARGV[1]) then
      return redis.call('SET', KEYS[1], ARGV[2], 'EX', 5)
    end
  `;
  return {
    read: async () => (await client.mGet(keys)).filter(Boolean).map(value => JSON.parse(value)),
    write: rows => Promise.all(rows.map(row => client.eval(lua, {
      keys:[prefix + row.sku], arguments:[String(row.revision), JSON.stringify(row)]
    })))
  };
}

async function main() {
  const env = process.env;
  const key = env.RAZORPAY_KEY_ID;
  const configured = [key, env.RAZORPAY_KEY_SECRET, env.RAZORPAY_WEBHOOK_SECRET];
  if (configured.some(Boolean) && !configured.every(Boolean)) throw new Error('Set all three Razorpay credentials together.');
  const mode = key ? key.startsWith('rzp_test_') ? 'test' : 'live' : 'demo';
  if (mode === 'live' && (env.LIVE_CHECKOUT !== 'true' || !env.SMTP_URL || !env.MAIL_FROM || !env.REDIS_URL)) {
    throw new Error('Live checkout requires explicit opt-in, SMTP, and Redis.');
  }
  const store = openStore(env.DATABASE_PATH || (mode === 'demo' ? 'demo.sqlite' : 'munchmillet.sqlite'),
    Number(env.INITIAL_STOCK ?? (mode === 'demo' ? 12 : 0)));
  let mail = async order => console.log('Demo email job processed for order', order.id);
  if (env.SMTP_URL) {
    if (!env.MAIL_FROM) throw new Error('MAIL_FROM is required for SMTP.');
    const { default:nodemailer } = await import('nodemailer');
    const transport = nodemailer.createTransport(env.SMTP_URL, { connectionTimeout:15_000, greetingTimeout:15_000, socketTimeout:30_000 });
    mail = async (order, item) => {
      const customer = JSON.parse(order.customer);
      const confirmed = order.status === 'paid';
      await transport.sendMail({
        from:env.MAIL_FROM, to:customer.email, subject:confirmed ? 'Your MunchMillet order is placed' : 'Your MunchMillet payment needs review',
        text:confirmed ? 'Order ' + order.id + '\n' + order.qty + ' × ' + item.name + '\nTotal paid: INR ' + (order.amount / 100).toFixed(2)
          : 'Your payment for order ' + order.id + ' was received after stock became unavailable. We are reviewing it before fulfillment.'
      });
    };
  }
  const shop = createShop({
    store, key, mode, mail, secret:env.RAZORPAY_WEBHOOK_SECRET || 'local-demo-only',
    provider:key ? razorpay(key, env.RAZORPAY_KEY_SECRET) : async order => 'demo_order_' + order.id,
    cache:env.REDIS_URL ? await redisCache(env.REDIS_URL) : undefined
  });
  setInterval(() => shop.tick().catch(console.error), 600).unref();
  const port = Number(env.PORT || 3000);
  shop.server.listen(port, env.HOST || '127.0.0.1', () => console.log('MunchMillet listening on port', port, '(' + mode + ')'));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});


