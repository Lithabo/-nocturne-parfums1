import PDFDocument from 'pdfkit';
import { transaction } from './db.js';

const env = process.env;
export const rand = cents => 'R '+(cents/100).toFixed(2);

export async function invoice(store, order) {
  const pdf = new PDFDocument({margin:50,size:'A4'});
  const chunks = [];
  const result = new Promise((resolve,reject) => {
    pdf.on('data',chunk => chunks.push(chunk));
    pdf.on('end',() => resolve(Buffer.concat(chunks)));
    pdf.on('error',reject);
  });
  pdf.fontSize(24).text(store.name).moveDown();
  pdf.fontSize(15).text('Paid invoice').moveDown();
  pdf.fontSize(10).text('Order reference: '+order.ref);
  pdf.text('Payment date: '+new Date(order.paid_at).toLocaleDateString('en-ZA',{timeZone:'Africa/Johannesburg'})).moveDown();
  pdf.text('Bill to: '+order.customer.name).text(order.customer.email);
  pdf.text([order.customer.address,order.customer.city,order.customer.province,order.customer.postcode].join(', ')).moveDown();
  for (const item of order.items) pdf.text(item.quantity+' × '+item.name+'  '+rand(item.price_cents*item.quantity));
  pdf.moveDown().text('Shipping: '+rand(order.shipping_cents));
  pdf.fontSize(13).text('Total paid: '+rand(order.amount));
  pdf.end();
  return result;
}

async function sendEmail(job,store,record) {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM || !store.email) throw new Error('Email configuration missing');
const customerInvoice = job.kind === 'customer_invoice_email';
const order = job.kind === 'order_email' || customerInvoice;
  const payload = {
    from:env.MAIL_FROM,to:[customerInvoice ? record.customer.email : store.email],
    subject:order?'Paid invoice '+record.ref:'New enquiry for '+store.name,
    text:order?'Payment received for '+rand(record.amount)+'. The invoice is attached.':
      record.details.name+' <'+record.details.email+'>\n\n'+record.details.message
  };
  if (order) payload.attachments = [{filename:'invoice-'+record.ref+'.pdf',content:(await invoice(store,record)).toString('base64')}];
  else payload.reply_to = record.details.email;
  const response = await fetch('https://api.resend.com/emails',{
    method:'POST',headers:{Authorization:'Bearer '+env.RESEND_API_KEY,'Content-Type':'application/json',
      'Idempotency-Key':'nocturne-notification-'+job.id},body:JSON.stringify(payload),signal:AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error('Resend HTTP '+response.status);
  await response.body?.cancel();
}

async function sendWhatsApp(job,store,record) {
  const order = job.kind === 'order_whatsapp';
  const sid = env.TWILIO_ACCOUNT_SID;
  const template = order ? env.TWILIO_ORDER_TEMPLATE : env.TWILIO_CONTACT_TEMPLATE;
  if (!sid || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_WHATSAPP_FROM || !template || !store.whatsapp)
    throw new Error('WhatsApp configuration missing');
  const response = await fetch('https://api.twilio.com/2010-04-01/Accounts/'+sid+'/Messages.json',{
    method:'POST',headers:{Authorization:'Basic '+Buffer.from(sid+':'+env.TWILIO_AUTH_TOKEN).toString('base64')},
    body:new URLSearchParams({
      From:'whatsapp:'+env.TWILIO_WHATSAPP_FROM,To:'whatsapp:'+store.whatsapp,ContentSid:template,
      ContentVariables:JSON.stringify(order ? {1:store.name,2:record.ref,3:rand(record.amount)} : {1:store.name,2:record.id})
    }),signal:AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error('Twilio HTTP '+response.status);
  await response.body?.cancel();
}

async function deliverNext() {
  return transaction(async db => {
    const {rows:[job]} = await db.query(`SELECT * FROM notifications WHERE sent_at IS NULL AND attempts<8
      AND next_attempt<=now() ORDER BY next_attempt,id LIMIT 1 FOR UPDATE SKIP LOCKED`);
    if (!job) return false;
    try {
      const {rows:[store]} = await db.query('SELECT name,email,whatsapp FROM stores WHERE slug=$1',[job.store_slug]);
      const query = (job.kind.startsWith('order_') || job.kind === 'customer_invoice_email')
        ? 'SELECT * FROM purchases WHERE ref=$1 AND store_slug=$2' : 'SELECT * FROM contacts WHERE id=$1 AND store_slug=$2';
      const {rows:[record]} = await db.query(query,[job.subject_id,job.store_slug]);
      if (job.kind.endsWith('_email')) await sendEmail(job,store,record);
      else await sendWhatsApp(job,store,record);
      await db.query('UPDATE notifications SET sent_at=now(),last_error=NULL WHERE id=$1',[job.id]);
    } catch (error) {
      const detail = /^(Email configuration|WhatsApp configuration|Resend HTTP|Twilio HTTP)/.test(error.message)
        ? error.message : 'Delivery failed. Check provider configuration and logs.';
      await db.query(`UPDATE notifications SET attempts=attempts+1,last_error=$2,
        next_attempt=now()+interval '1 minute'*power(2,attempts) WHERE id=$1`,[job.id,detail]);
    }
    return true;
  });
}

export function startNotifications() {
  async function run() {
    try {
      for (let i=0;i<10;i++) if (!await deliverNext()) break;
    } catch (error) {
      console.error('Notification queue error',error.code || error.name);
    } finally {
      setTimeout(run,3000).unref();
    }
  }
  void run();
}
