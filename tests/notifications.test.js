
import test from 'node:test';
import assert from 'node:assert/strict';
import { sendEmail } from '../notifications.js';

test('Customer receives a PDF invoice after payment', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.RESEND_API_KEY;
  const originalFrom = process.env.MAIL_FROM;

  const requests = [];

  try {
    process.env.RESEND_API_KEY = 'test-api-key';
    process.env.MAIL_FROM = 'onboarding@resend.dev';

    globalThis.fetch = async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        status: 200,
        body: { cancel: async () => {} }
      };
    };

    const store = {
      name: 'Nocturne Parfums',
      email: 'owner@example.com'
    };

    const order = {
      ref: 'TEST-INV-001',
      customer: {
        name: 'Test Customer',
        email: 'customer@example.com',
        address: 'Test Street',
        city: 'Durban',
        province: 'KwaZulu-Natal',
        postcode: '4000'
      },
      items: [
        {
          name: 'The Blue Hour',
          quantity: 1,
          price_cents: 150000
        }
      ],
      shipping_cents: 10000,
      amount: 160000,
      paid_at: new Date().toISOString()
    };

    await sendEmail(
      { id: 999, kind: 'customer_invoice_email' },
      store,
      order
    );

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://api.resend.com/emails');

    const payload = JSON.parse(requests[0].options.body);

    assert.deepEqual(payload.to, ['customer@example.com']);
    assert.match(payload.subject, /Paid invoice/);
    assert.equal(payload.attachments.length, 1);
    assert.equal(payload.attachments[0].filename, 'invoice-TEST-INV-001.pdf');

    const pdf = Buffer.from(payload.attachments[0].content, 'base64');
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  } finally {
    globalThis.fetch = originalFetch;

    if (originalKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = originalKey;

    if (originalFrom === undefined) delete process.env.MAIL_FROM;
    else process.env.MAIL_FROM = originalFrom;
  }
});
