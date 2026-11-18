const $ = selector => document.querySelector(selector);
const grid = $('#grid');
const dialog = $('#checkout');
const form = $('#buyer');
const pay = $('#pay');
const status = $('#status');
const track = $('#track');
const money = paise => new Intl.NumberFormat('en-IN', { style:'currency', currency:'INR', minimumFractionDigits:0, maximumFractionDigits:2 }).format(paise / 100);
let selected, paymentMode, tracked, checkoutScript, pollTimer;
try { tracked = sessionStorage.getItem('mm-order'); } catch {}
track.hidden = !tracked;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function palette(node, item) {
  node.style.setProperty('--color', item.color);
  node.style.setProperty('--ink', item.ink);
}
function tin(item) {
  const node = element('div', '', 'tin');
  palette(node, item);
  const mark = { beetroot:'◉', amla:'✿', ginger:'✺', orange:'◌', cinnamon:'≋', original:'❧' };
  const name = element('small', 'MunchMillet ❧');
  const logo = element('b', 'FIBER');
  logo.append(document.createElement('br'), 'HOOD');
  node.append(name, logo, element('i', item.name), element('span', mark[item.sku], 'mark'));
  return node;
}
function productArt(item, hasPhoto) {
  const art = element('div', '', 'product-art');
  art.setAttribute('aria-hidden', 'true');
  palette(art, item);
  const illustration = tin(item);
  art.append(illustration);
  if (hasPhoto) {
    const frame = element('div', '', 'photo-crop');
    const coordinates = {
      beetroot:[146,124,212,295], amla:[371,124,204,295], ginger:[588,124,210,295],
      orange:[811,124,206,295], cinnamon:[276,421,212,300], original:[502,420,218,306]
    };
    const [x,y,w,h] = coordinates[item.sku];
    frame.style.aspectRatio = w + '/' + h;
    frame.style.backgroundSize = (1147 / w * 100) + '% ' + (751 / h * 100) + '%';
    frame.style.backgroundPosition = (x / (1147 - w) * 100) + '% ' + (y / (751 - h) * 100) + '%';
    frame.style.backgroundImage = 'url(/lineup.png)';
    illustration.replaceWith(frame);
  }
  return art;
}
function setStock(card, item) {
  card.querySelector('button').disabled = item.available === 0;
  card.querySelector('.availability').textContent = item.available === 0 ? 'Sold out' : item.available <= 5 ? 'Only ' + item.available + ' available' : 'In stock';
  card.querySelector('.price').textContent = money(item.price);
}
function makeCard(item, index, hasPhoto) {
  const card = element('article', '', 'card');
  card.dataset.sku = item.sku;
  card.style.setProperty('--delay', (index * 55) + 'ms');
  const info = element('div', '', 'card-text');
  const row = element('div', '', 'buy-row');
  const button = element('button', 'Buy now', 'cta');
  button.setAttribute('aria-label', 'Buy ' + item.name);
  button.onclick = () => openCheckout(products.get(item.sku));
  row.append(element('span', '', 'price'), button);
  info.append(element('h3', item.name), element('p', item.note), row, element('span', '', 'availability'));
  card.append(productArt(item, hasPhoto), info);
  setStock(card, item);
  return card;
}
const labels = ['Plant fiber', 'Psyllium husk', 'Six flavors', 'Good Gut, Real You.'];
for (let repeat = 0; repeat < 4; repeat++) {
  for (const name of labels) {
    const label = element('span', name);
    label.append(element('b', '✦'));
    $('.ribbon-track').append(label);
  }
}

async function api(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Please try again.');
  return body;
}
const post = (url, body) => api(url, { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(body) });
const products = new Map();
let initialized = false;
async function refresh() {
  try {
    const result = await api('/api/catalog');
    paymentMode = result.mode;
    const lineup = $('.lineup');
    if (result.hasPhoto && !lineup.getAttribute('src')) {
      lineup.onload = () => {
        lineup.hidden = false;
        lineup.parentElement.classList.add('has-image');
      };
      lineup.src = '/lineup.png';
    }
    $('#mode').textContent = paymentMode === 'demo' ? 'Demo store · Sample prices · Simulated payment' :
      paymentMode === 'test' ? 'Razorpay test mode · Use test payment details' : '';
    const cards = [];
    result.products.forEach((item, index) => {
      products.set(item.sku, item);
      if (!initialized) cards.push(makeCard(item, index, result.hasPhoto));
      else setStock(grid.children[index], item);
    });
    if (!initialized) {
      $('#hero-tins').append(...['beetroot','amla','orange'].map(sku => tin(products.get(sku))));
      grid.replaceChildren(...cards);
      initialized = true;
    }
  } catch {
    if (!initialized) grid.textContent = 'The collection is temporarily unavailable.';
  }
}

function openCheckout(item) {
  clearTimeout(pollTimer);
  selected = item;
  form.reset();
  form.hidden = false;
  form.elements.qty.max = Math.min(10, item.available);
  $('#checkout-title').textContent = 'Checkout';
  $('#summary').textContent = item.name + ' · ' + money(item.price) + ' per tin';
  status.replaceChildren();
  pay.textContent = paymentMode === 'demo' ? 'Continue to demo payment' : 'Continue to Razorpay';
  dialog.showModal();
}

function remember(id) {
  tracked = id;
  try { sessionStorage.setItem('mm-order', id); } catch {}
  track.hidden = false;
}
function watch(id) {
  clearTimeout(pollTimer);
  $('#checkout-title').textContent = 'Order status';
  $('#summary').textContent = 'Order ' + id;
  form.hidden = true;
  status.textContent = 'Checking payment status…';
  async function check() {
    if (!dialog.open) return;
    try {
      const result = await api('/api/orders/' + id);
      if (!dialog.open || tracked !== id) return;
      const labels = {
        paid: 'Order placed',
        pending: 'Awaiting payment confirmation',
        expired: 'Stock reservation expired',
        review: 'Payment received · Order under review'
      };
      $('#checkout-title').textContent = labels[result.status];
      const detail = {
        paid: (paymentMode === 'demo' ? 'Simulated payment confirmed for ' : 'Payment confirmed for ') + money(result.amount) + '.',
        pending: 'This page updates when the payment is confirmed.',
        expired: 'We released the reserved stock. If a delayed payment is confirmed, this status will update.',
        review: 'Stock became unavailable before payment was confirmed. Your order needs a fulfillment or refund review.'
      };
      status.textContent = detail[result.status];
      if (result.status === 'pending' || result.status === 'expired') pollTimer = setTimeout(check, 2300);
      if (result.status === 'paid') void refresh();
    } catch {
      if (!dialog.open || tracked !== id) return;
      status.textContent = 'Connection interrupted. Checking again shortly…';
      pollTimer = setTimeout(check, 3500);
    }
  }
  void check();
}

function loadRazorpay() {
  if (window.Razorpay) return Promise.resolve();
  if (!checkoutScript) checkoutScript = new Promise((resolve, reject) => {
    const script = element('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.onload = resolve;
    script.onerror = () => { checkoutScript = null; script.remove(); reject(new Error('Could not load Razorpay.')); };
    document.head.append(script);
  });
  return checkoutScript;
}
form.onsubmit = async event => {
  event.preventDefault();
  pay.disabled = true;
  const input = Object.fromEntries(new FormData(form));
  const qty = Number(input.qty);
  delete input.qty;
  try {
    if (paymentMode !== 'demo') await loadRazorpay();
    const order = await post('/api/checkout', { sku:selected.sku, qty, customer:input });
    remember(order.id);
    form.hidden = true;
    $('#summary').textContent = selected.name + ' × ' + qty + ' · ' + money(order.amount);
    if (order.mode === 'demo') {
      const simulate = element('button', 'Simulate payment', 'cta');
      simulate.onclick = async () => {
        simulate.disabled = true;
        try {
          await post('/api/orders/' + order.id + '/demo-pay', {});
          watch(order.id);
        } catch (error) { status.append(element('p', error.message)); simulate.disabled = false; }
      };
      status.replaceChildren(element('p', 'Demo checkout. No money will be charged.'), simulate);
    } else {
      const show = () => { if (dialog.open) watch(order.id); };
      dialog.close();
      const gateway = new window.Razorpay({
        key:order.key, order_id:order.providerOrder, amount:order.amount, currency:'INR',
        name:'MunchMillet', description:selected.name,
        prefill:{ name:input.name, email:input.email, contact:input.phone },
        theme:{ color:'#25331d' },
        handler:() => { if (!dialog.open) dialog.showModal(); show(); },
        modal:{ ondismiss:() => { if (!dialog.open) dialog.showModal(); show(); } },
      });
      gateway.open();
    }
  } catch (error) {
    if (!dialog.open) dialog.showModal();
    status.textContent = error.message;
    form.hidden = false;
    void refresh();
  } finally {
    pay.disabled = false;
  }
};
track.onclick = () => { dialog.showModal(); watch(tracked); };
$('#close').onclick = () => { if (!pay.disabled) dialog.close(); };
dialog.addEventListener('cancel', event => { if (pay.disabled) event.preventDefault(); });
dialog.addEventListener('close', () => { if (!dialog.open) clearTimeout(pollTimer); });
void refresh();
setInterval(() => { if (!document.hidden) void refresh(); }, 4000);



