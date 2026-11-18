import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createShop } from '../server.mjs';
import { openStore } from '../store.mjs';
import { sign } from '../payments.mjs';

const secret = 'test-webhook-secret';
const customer = {name:'Test Buyer',email:'buyer@example.test',phone:'9999999999',pin:'442401',address:'Test Street, Chandrapur, Maharashtra'};
const purchase = {sku:'amla',qty:1,customer};
const t0 = 1_000_000;
function signed(order, overrides = {}, event = 'payment.captured') {
  const body = JSON.stringify({ event, payload:{payment:{entity:{
    id:'pay_' + order.id, order_id:order.providerOrder, currency:'INR', amount:order.amount, status:'captured', ...overrides
  }}} });
  return { body, signature:sign(body, secret) };
}

async function fixture(t, options = {}) {
  let now = t0;
  const time = () => now;
  const directory = await mkdtemp(join(tmpdir(), 'munchmillet-'));
  const path = join(directory,'store.sqlite');
  const stock = options.stock ?? 1;
  let store = openStore(path, stock, time);
  const delivered = [];
  const errors = [];
  let shop;

  async function start() {
    shop = createShop({
      store, provider:options.provider || (async order => 'order_' + order.id),
      secret, mode:options.mode || 'test', key:'rzp_test_fake', cache:options.cache,
      mail:options.mail || (async (order,item) => delivered.push({ order,item })),
      onError:error => errors.push(error)
    });
  }
  async function stop() {
    store.close();
  }
  await start();
  t.after(async () => { await stop(); await rm(directory,{recursive:true,force:true}); });
  async function request(route, options) {
    const request = Readable.from(options?.body ? [Buffer.from(options.body)] : []);
    Object.assign(request, { url:route, method:options?.method || 'GET', headers:options?.headers || {} });
    const handler = shop.server.listeners('request')[0];
    const result = await new Promise((resolve, reject) => {
      let code;
      let headers;
      const response = {
        setHeader() {},
        writeHead(status, values) { code = status; headers = values; },
        end(bytes) {
          const value = Buffer.from(bytes).toString();
          resolve({ status:code, body:headers['content-type'].includes('json') ? JSON.parse(value) : value });
        }
      };
      handler(request, response).catch(reject);
    });
    return result;
  }
  const post = (route, body) => request(route,{method:'POST',body:JSON.stringify(body)});
  const webhook = ({ body, signature }) => request('/api/webhooks/razorpay',{method:'POST',body,headers:{'x-razorpay-signature':signature}});
  return {
    request, post, webhook, delivered, errors, advance:ms => {now += ms;}, tick:() => shop.tick(),
    restart:async () => {await stop(); store = openStore(path, stock, time); await start();},
    order:id => request('/api/orders/' + id), buy:body => post('/api/checkout', body ?? purchase),
    available:async () => (await request('/api/catalog')).body.products.find(item => item.sku === 'amla').available
  };
}

test('serves storefront and exact six pictured flavors', async t => {
  const f = await fixture(t);
  const page = await f.request('/');
  assert.equal(page.status,200);
  assert.match(page.body,/Daily fiber/);
  assert.equal((await f.request('/app.js')).status,200);
  assert.deepEqual((await f.request('/api/catalog')).body.products.map(x => x.name),
    ['Beetroot Twist','Amla Zest','Ginger Twist','Citrus Orange','Cinnamon Spice','Original']);
});

test('only one of 16 checkouts can reserve the final unit', async t => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length:16 }, () => f.buy()));
  assert.equal(results.filter(r => r.status === 201).length,1);
  assert.equal(results.filter(r => r.status === 409).length,15);
  assert.equal(await f.available(),0);
});

test('checks buyer input and prices on the server', async t => {
  const f = await fixture(t);
  assert.equal((await f.buy({...purchase,qty:-1})).status,400);
  assert.equal((await f.buy({...purchase,customer:{...customer,pin:'0'}})).status,400);
  assert.equal((await f.buy({...purchase,amount:1})).body.amount,49900);
});

test('webhook verifies raw bytes and rejects incorrect amounts and currency', async t => {
  const f = await fixture(t);
  const {body:order} = await f.buy();
  const valid = signed(order);
  assert.equal((await f.webhook({...valid,body:valid.body + ' '})).status,401);
  assert.equal((await f.webhook(signed(order,{amount:1}))).status,422);
  assert.equal((await f.webhook(signed(order,{currency:'USD'}))).status,422);
  assert.equal((await f.webhook(signed(order,{},'payment.authorized'))).status,200);
  await f.tick();
  assert.equal((await f.order(order.id)).body.status,'pending');
  assert.equal(f.delivered.length,0);
});

test('duplicate webhooks survive restart and queue one fulfillment and email', async t => {
  const f = await fixture(t);
  const {body:order} = await f.buy();
  assert.equal((await f.webhook(signed(order))).status,200);
  assert.equal((await f.webhook(signed(order))).status,200);
  assert.equal((await f.order(order.id)).body.status,'pending');
  await f.restart();
  await f.tick();
  assert.equal((await f.order(order.id)).body.status,'paid');
  assert.equal((await f.order(order.id)).body.customer,undefined);
  assert.equal(f.delivered.length,1);
  assert.equal(JSON.parse(f.delivered[0].order.customer).email,customer.email);
  assert.equal(await f.available(),0);
  await f.webhook(signed(order));
  await f.tick();
  assert.equal(f.delivered.length,1);
});

test('provider failure releases stock and SMTP failure retries the email', async t => {
  let creates = 0;
  let attempts = 0;
  const f = await fixture(t,{
    provider:async order => { if (++creates === 1) throw Error('provider offline'); return order.id; },
    mail:async () => { if (++attempts === 1) throw Error('SMTP offline'); }
  });
  assert.equal((await f.buy()).status,503);
  assert.equal(await f.available(),1);
  const {body:order} = await f.buy();
  await f.webhook(signed(order));
  await f.tick();
  assert.equal((await f.order(order.id)).body.status,'paid');
  assert.equal(attempts,1);
  f.advance(5000);
  await f.tick();
  assert.equal(attempts,2);
});

test('late payment goes to review when the released unit has been reserved again', async t => {
  const f = await fixture(t);
  const {body:old} = await f.buy();
  f.advance(16 * 60_000);
  await f.tick();
  assert.equal(await f.available(),1);
  const {body:current} = await f.buy();
  await f.webhook(signed(old));
  await f.webhook(signed(current));
  await f.tick();
  assert.equal((await f.order(old.id)).body.status,'review');
  assert.equal((await f.order(current.id)).body.status,'paid');
  assert.equal(await f.available(),0);
});

test('demo checkout exercises payment verification and queue without a provider', async t => {
  const f = await fixture(t,{mode:'demo'});
  const {body:order} = await f.buy();
  assert.equal((await f.post('/api/orders/' + order.id + '/demo-pay',{})).status,202);
  await f.tick();
  assert.equal((await f.order(order.id)).body.status,'paid');
  assert.equal(f.delivered.length,1);
});

test('inventory cache refreshes after a reservation and falls back during outage', async t => {
  let rows;
  let unavailable = false;
  let reads = 0;
  const f = await fixture(t,{cache:{
    read:async () => { reads++; if (unavailable) throw Error('offline'); return rows; },
    write:async value => { if (unavailable) throw Error('offline'); rows = value; }
  }});
  assert.equal(await f.available(),1);
  assert.equal((await f.buy()).status,201);
  assert.equal(rows.find(x => x.sku === 'amla').available,0);
  assert.equal(await f.available(),0);
  unavailable = true;
  assert.equal(await f.available(),0);
  assert.equal(reads,3);
});


test('a captured payment already queued protects its hold from expiry', async t => {
  const f = await fixture(t);
  const {body:order} = await f.buy();
  await f.webhook(signed(order));
  f.advance(16 * 60_000);
  await f.tick();
  assert.equal((await f.order(order.id)).body.status,'paid');
  assert.equal(await f.available(),0);
  assert.equal((await f.buy()).status,409);
});
