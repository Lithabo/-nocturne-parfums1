# Nocturne Parfums and LiboTech commerce

This is a Node.js and PostgreSQL source project for VS Code. It carries over the original Nocturne artwork, colours, menu animation and “Created by Libotech” footer. The public store reads the catalogue from PostgreSQL. The platform dashboard is at /admin.

## Run it on Windows

1. Extract the ZIP. In VS Code, open the **nocturne-commerce** folder.
2. Install Node.js 22 or newer and PostgreSQL. Use pgAdmin to create a database named **nocturne**.
3. Open **Terminal → New Terminal** and run these PowerShell commands.

   ```powershell
   npm.cmd install
   Copy-Item .env.example .env
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
   ```

4. In VS Code Explorer, open **.env**. Enter your PostgreSQL connection URL. If your database password contains URL-reserved characters, percent-encode them in the URL. Paste the generated key into **STORE_ENCRYPTION_KEY** and choose a unique **ADMIN_PASSWORD** of at least 20 characters. Keep the encryption key backed up securely because changing it makes stored merchant keys unreadable.
5. Start the project.

   ```powershell
   npm.cmd run db:setup
   npm.cmd start
   ```

6. Open **http://localhost:3000**. Visit **http://localhost:3000/admin** and sign in with username **admin** and your chosen password. Run **npm.cmd run check** to check the JavaScript syntax.

To change the design, use **public/index.html**, **public/style.css**, and the WebP images. Manage products in the dashboard. The three seeded products, prices and images came from the original storefront. Confirm your real names, prices, artwork and shipping fee before launch. The seed uses a zero shipping fee unless you set **NOCTURNE_SHIPPING_CENTS**. Running db:setup again updates Nocturne’s payment and notification settings from .env.

## Take card payments with Paystack

Paystack is the recommended fit for this implementation because it offers hosted card checkout in South Africa and recurring card billing for the SaaS subscription. Card details are entered on Paystack’s checkout page. PostgreSQL stores order details and payment references.

- **Store sales** use the store merchant’s own Paystack account. Set **NOCTURNE_PAYSTACK_SECRET** for the flagship store, or enter a client’s key in their dashboard store record. Each store uses a separate Paystack integration with its own webhook address. The webhook for Nocturne is **https://YOUR-HOST/hooks/paystack/store/nocturne**. For another store, replace the final segment with its slug. The owner receives store sale payouts through that merchant account.
- **SaaS fees** use a separate LiboTech Paystack integration with webhook **https://YOUR-HOST/hooks/paystack/platform**. Create a **monthly ZAR card plan**, then set **PLATFORM_PAYSTACK_SECRET**, **PLATFORM_PLAN_CODE** and **PLATFORM_MONTHLY_CENTS**. For example, R499 per month is **49900** cents. This is an example, and you set the price.
- Use Paystack test keys first. The Paystack dashboard needs a reachable HTTPS webhook for reliable confirmation and renewals. For full tests, run the project on an HTTPS staging URL with its own database, set **PUBLIC_URL** to that exact origin, and register the staging webhooks in test mode.
- Paystack’s **Test Cards** page provides card details for test mode. Use sandbox transactions for success and failure. The app checks the signed webhook and verifies the reference, amount, currency and payment channel. If a customer closes the browser after paying, the webhook still records the order.
- Use verified live merchant accounts and replace test keys only after staging checks pass. Keep test and live databases separate. Payment refunds and disputes are handled in Paystack and require manual order reconciliation in this version.

Provider documentation
- Pricing https://paystack.com/za/pricing
- Subscriptions https://paystack.com/docs/payments/subscriptions/
- Test payments https://paystack.com/docs/payments/test-payments/

## Notify the store owner

In the LiboTech dashboard, each store has its own email and WhatsApp recipient. For Nocturne you can also seed **NOCTURNE_EMAIL** and **NOCTURNE_WHATSAPP**. Enter WhatsApp numbers in international format such as **+27…**.

| Event | Email | WhatsApp |
|---|---|---|
| Verified card order | PDF paid invoice sent to the store owner | Store name, order reference and amount |
| Contact form submitted | Sender and full message sent to the store owner | Store name and enquiry reference |

- **Email** uses Resend. Set **RESEND_API_KEY** and **MAIL_FROM** using an address on your verified sending domain. The invoice is a paid-order PDF. Update the invoice layout and business identifiers to match your invoicing requirements before using it for live sales.
- **WhatsApp** uses Twilio. Add a WhatsApp sender and obtain recipient opt-in. Set **TWILIO_ACCOUNT_SID**, **TWILIO_AUTH_TOKEN**, **TWILIO_WHATSAPP_FROM** (international number without the whatsapp: prefix), and approved template IDs for **TWILIO_ORDER_TEMPLATE** and **TWILIO_CONTACT_TEMPLATE**.
- Use templates with these variables in the stated order. Order example “New paid order for {{1}}. Reference {{2}}. Total {{3}}.” Contact example “New contact enquiry for {{1}}. Reference {{2}}. Check your email for details.”
- PostgreSQL queues notifications after successful payment or contact submission. Keep the Node process running to deliver them. The admin dashboard shows failed delivery attempts and lets you retry. Provider acceptance and delivery to the recipient are different. Check Resend or Twilio logs for final delivery. A timeout can cause duplicate WhatsApp alerts on retry.

## Onboard a monthly client

1. In **/admin**, create a store with a new slug, unique billing email, notification number, delivery fee and merchant key. Add its products. Every store has scoped products, orders, enquiries and checkout records.
2. Select **Get subscription link** and share the Paystack link with the client. Once their initial card payment is verified, their store has one month of access. Paystack bills subsequent months and signed invoice events extend access after a successful renewal.
3. Give the client their storefront URL **https://YOUR-HOST/?store=their-slug**. Product images use the shared Nocturne design assets in this release. The dashboard is operated by LiboTech and does not provide separate merchant logins.
4. Use **Get Paystack management link** for the linked client’s Paystack controls. Use the storefront toggle to suspend or restore store access. Suspending a storefront does not cancel Paystack billing. Use the Paystack management tools to cancel billing.
5. If a billing link fails during creation or a client needs to restart after cancellation, reconcile the previous Paystack transaction and subscription before clearing the old billing record. The app blocks a second initial subscription for the same tenant to avoid accidental duplicate billing. Reconcile failed payments or missing subscription events in Paystack.

## Before switching to live keys

Host this as a Node service with a continuously running process, HTTPS and persistent PostgreSQL. Set **NODE_ENV=production** and the exact **PUBLIC_URL**. Configure **TRUST_PROXY_HOPS** only if your host documents the number of trusted reverse proxy hops. Keep .env and database credentials out of source control. Set up PostgreSQL backups and confirm you can restore them.

Test a paid card purchase, an unsuccessful checkout, repeat delivery of the same payment webhook, invoice attachment, both WhatsApp notifications, contact form submission, a monthly subscription and a renewal. Check the database and dashboard against each provider’s records. Confirm that one store’s checkout can only buy products from that store.

Decide how you will handle stock, shipping zones, refunds and returns. This version uses a flat delivery fee and manual fulfilment from the dashboard. It has no stock reservation, carrier integration, tax calculation, merchant self-service dashboard, customer accounts, or custom domain setup per tenant. Add your real delivery terms, privacy notice and returns policy before accepting customer data or payments.
