# MunchMillet Fiber Hood

An animated storefront and checkout for Beetroot Twist, Amla Zest, Ginger Twist, Citrus Orange, Cinnamon Spice, and Original.

## Run the demo

Requires Node.js 24 or newer. No installation or accounts are needed for the demo. From this directory run:

```sh
npm test
npm start
```

Open http://127.0.0.1:3000. Choose a flavor, enter sample delivery details, and click **Simulate payment**. The status switches to **Order placed** after the worker processes the captured-payment job. Demo orders are stored in demo.sqlite, and the email job writes an order ID to the console. The demo starts with 12 units of each flavor and uses sample prices of ₹449 and ₹499.

The storefront shows illustrated tins. To use the supplied lineup photo, save it as public/lineup.png and restart the server. The six product cards crop their individual tins from the same photo.

## Validate with test services

1. Run npm install. Start Redis and Mailpit with docker compose up -d, or use equivalent services.
2. Copy .env.example to .env. Set the Razorpay test key ID, key secret, and a separate webhook secret. Adjust INITIAL_STOCK before creating a new database or use the inventory command below. Never put merchant credentials in the frontend.
3. Start the server. Expose it over HTTPS using your test deployment or a tunnel, then configure /api/webhooks/razorpay on that origin for payment.captured in the Razorpay test dashboard. Use automatic capture in the Razorpay account. Refer to [Standard Checkout](https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/) and [webhook verification](https://razorpay.com/docs/webhooks/validate-test/).
4. Use a Razorpay test payment. Confirm that the order reaches **Order placed**, stock updates, and the message appears in Mailpit at http://127.0.0.1:8025. Replay the capture and confirm the same order and stock count. Verify the Redis inventory keys expire and are repopulated after reads.
5. Run a checkout with zero available units and confirm it cannot proceed. Check an abandoned reservation after 15 minutes and confirm the unit returns to stock.

## Inventory and payment operations

```sh
node --env-file-if-exists=.env manage.mjs inventory
node --env-file-if-exists=.env manage.mjs set amla 49900 30
node --env-file-if-exists=.env manage.mjs review
```

The set command takes a price in paise and the count of available unreserved units. Existing orders retain their purchase price. If a captured payment arrives after expiration, the worker tries to reserve the unit again. If stock has sold out, the order enters review and the customer receives a review email. Resolve those entries in the merchant dashboard before fulfillment or via a refund. The worker does not initiate refunds.

SQLite stores orders, inventory, and jobs on a persistent volume. The transaction that reserves inventory prevents concurrent overselling. Redis caches availability, refreshes on changes, and falls back to the database. Browser availability refreshes every four seconds. The webhook stores a durable capture job before responding. The worker applies the order update and creates the email job in one transaction. Email retries after failures. SMTP delivery can repeat if the process stops after SMTP accepts a message but before the job completion is saved.

The automated suite uses the actual server request handler and a real SQLite database. It substitutes Razorpay, the Redis adapter, and SMTP. A live browser session and real-service test require a network-enabled environment.

For live checkout, replace sample prices and stock with merchant values, use persistent disk, configure a verified SMTP sender and Redis, set live keys and LIVE_CHECKOUT=true, and configure the live HTTPS webhook. Deploy the Node app on a host that supports persistent storage and outbound Redis/SMTP connections. Keep SQLite on a single host for this first phase. The application does not calculate shipping fees or taxes separately. The total equals the configured unit price times quantity.

