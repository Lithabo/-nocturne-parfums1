
import test from 'node:test';
import assert from 'node:assert/strict';
import { sendEmail, deliverNext } from '../notifications.js';

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

test('Resend failure is reported correctly', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.RESEND_API_KEY;
  const originalFrom = process.env.MAIL_FROM;

  try {
    process.env.RESEND_API_KEY = 'test-api-key';
    process.env.MAIL_FROM = 'onboarding@resend.dev';

    // Simulate Resend rejecting the email.
    globalThis.fetch = async () => ({
      ok: false,
      status: 503
    });

    const store = {
      name: 'Nocturne Parfums',
      email: 'owner@example.com'
    };

    const order = {
      ref: 'TEST-FAIL-001',
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

    await assert.rejects(
      sendEmail(
        { id: 1000, kind: 'customer_invoice_email' },
        store,
        order
      ),
      /Resend HTTP 503/
    );
  } finally {
    globalThis.fetch = originalFetch;

    if (originalKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = originalKey;

    if (originalFrom === undefined) delete process.env.MAIL_FROM;
    else process.env.MAIL_FROM = originalFrom;
  }
});

test('Failed email is scheduled for automatic retry', async () => {
  const queries = [];

  const job = {
    id: 101,
    kind: 'customer_invoice_email',
    store_slug: 'nocturne',
    subject_id: 'TEST-ORDER-101',
    attempts: 0
  };

  const mockDb = {
    async query(sql, params = []) {
      queries.push({ sql, params });

      if (sql.includes('SELECT * FROM notifications')) {
        return { rows: [job] };
      }

      if (sql.includes('SELECT name,email,whatsapp FROM stores')) {
        return {
          rows: [{
            name: 'Nocturne Parfums',
            email: 'owner@example.com'
          }]
        };
      }

      if (sql.includes('SELECT * FROM purchases')) {
        return {
          rows: [{
            ref: 'TEST-ORDER-101',
            customer: { email: 'customer@example.com' }
          }]
        };
      }

      if (sql.includes('UPDATE notifications')) {
        return { rowCount: 1, rows: [] };
      }

      throw new Error('Unexpected database query: ' + sql);
    }
  };

  const mockTransaction = async callback => callback(mockDb);

  const failedEmail = async () => {
    throw new Error('Resend HTTP 503');
  };

  const result = await deliverNext(
    mockTransaction,
    failedEmail
  );

  assert.equal(result, true);

  const retry = queries.find(
    entry => entry.sql.includes('attempts=attempts+1')
  );

  assert.ok(retry, 'A retry update should be scheduled');
  assert.equal(retry.params[0], 101);
  assert.equal(retry.params[1], 'Resend HTTP 503');
  assert.match(retry.sql, /next_attempt=now\(\)/);
  assert.match(retry.sql, /power\(2,attempts\)/);

  const markedSent = queries.some(
    entry => entry.sql.includes('SET sent_at=now()')
  );

  assert.equal(markedSent, false);
});
