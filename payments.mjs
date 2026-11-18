import { createHmac, timingSafeEqual } from 'node:crypto';

export const sign = (body, secret) => createHmac('sha256', secret).update(body).digest('hex');

export function capturedPayment(body, signature, secret) {
  if (!secret || !/^[a-f0-9]{64}$/i.test(signature || '')) return null;
  if (!timingSafeEqual(Buffer.from(sign(body, secret), 'hex'), Buffer.from(signature, 'hex'))) return null;
  const event = JSON.parse(body);
  if (event.event !== 'payment.captured') return false;
  const payment = event.payload?.payment?.entity;
  if (payment?.status !== 'captured' || typeof payment.id !== 'string' ||
      typeof payment.order_id !== 'string' || !Number.isSafeInteger(payment.amount)) return null;
  return payment;
}

export function razorpay(key, secret) {
  return async (order) => {
    const response = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST', signal: AbortSignal.timeout(12_000),
      headers: { authorization: 'Basic ' + Buffer.from(key + ':' + secret).toString('base64'), 'content-type':'application/json' },
      body: JSON.stringify({ amount: order.amount, currency: 'INR', receipt: order.id, partial_payment: false })
    });
    if (!response.ok) throw new Error('Razorpay order creation failed (' + response.status + ')');
    const result = await response.json();
    if (typeof result.id !== 'string' || result.amount !== order.amount || result.currency !== 'INR') {
      throw new Error('Unexpected Razorpay order response');
    }
    return result.id;
  };
}
