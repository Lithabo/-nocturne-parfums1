import { fileURLToPath } from 'node:url';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { pool, encrypt, decrypt, transaction } from './db.js';
import { startNotifications } from './notifications.js';

const app = express();
const env = process.env;
const origin = new URL(env.PUBLIC_URL || 'http://localhost:3000').origin;
if (env.NODE_ENV === 'production' && !origin.startsWith('https://')) throw new Error('Set an HTTPS PUBLIC_URL');
if (env.TRUST_PROXY_HOPS) app.set('trust proxy', Number(env.TRUST_PROXY_HOPS));
app.disable('x-powered-by');
app.use((_req,res,next) => {
  res.set({'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
    'Content-Security-Policy':"default-src 'self'; img-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});
  next();
});
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
const sku = slug;
const id = z.uuid();
const email = z.email().max(254);
const label = z.string().trim().min(1).max(120);
const whatsapp = z.string().regex(/^\+[1-9][0-9]{7,14}$/);
const money = z.number().int().min(0).max(10000000);
const getOne = async (query, params = []) => (await pool.query(query,params)).rows[0];
const problem = (status,message) => Object.assign(new Error(message),{status});
const enabled = 'enabled AND (subscription_status=\'owned\' OR access_until>now())';

async function paystack(key, path, body) {
  if (!key) throw problem(503,'Card payments are not configured.');
  const response = await fetch('https://api.paystack.co' + path, {
    method: body ? 'POST' : 'GET',
    headers: {Authorization:'Bearer '+key,'Content-Type':'application/json'},
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(12000)
  });
  const result = await response.json();
  if (!response.ok || !result.status) throw problem(502,'The payment provider could not complete the request.');
  return result.data;
}
const verify = (key, ref) => paystack(key,'/transaction/verify/'+encodeURIComponent(ref));
const matches = (data,ref,amount) => data?.status === 'success' && data.reference === ref &&
  data.amount === amount && data.currency === 'ZAR' && data.channel === 'card';

async function notify(db, store, prefix, ref) {
  for (const channel of ['email','whatsapp']) {
    await db.query('INSERT INTO notifications(store_slug,kind,subject_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
      [store,prefix+'_'+channel,ref]);
  }
}

async function paidOrder(store, ref) {
  const order = await getOne('SELECT * FROM purchases WHERE store_slug=$1 AND ref=$2',[store.slug,ref]);
  if (!order || order.paid_at) return Boolean(order?.paid_at);
  const data = await verify(decrypt(store.payment_key),ref);
  if (!matches(data,ref,order.amount)) return false;
  await transaction(async db => {
    const result = await db.query('UPDATE purchases SET paid_at=now() WHERE ref=$1 AND paid_at IS NULL RETURNING ref',[ref]);
    if (result.rowCount) await notify(db,store.slug,'order',ref);
  });
  return true;
}

async function initialSubscription(ref) {
  const link = await getOne('SELECT * FROM billing_links WHERE ref=$1',[ref]);
  if (!link || link.paid_at) return Boolean(link?.paid_at);
  const data = await verify(env.PLATFORM_PAYSTACK_SECRET,ref);
  if (!matches(data,ref,link.amount)) return false;
  await transaction(async db => {
    const result = await db.query('UPDATE billing_links SET paid_at=now() WHERE ref=$1 AND paid_at IS NULL RETURNING ref',[ref]);
    if (result.rowCount) {
      await db.query(`UPDATE stores SET access_until=GREATEST(now(),access_until)+interval '1 month',
        subscription_status='active' WHERE slug=$1`,[link.store_slug]);
    }
  });
  return true;
}

function signed(key, req) {
  const sig = req.get('x-paystack-signature') || '';
  if (!key || !Buffer.isBuffer(req.body) || !/^[a-f0-9]{128}$/i.test(sig)) return false;
  return timingSafeEqual(Buffer.from(sig,'hex'),createHmac('sha512',key).update(req.body).digest());
}

app.post('/hooks/paystack/store/:store', express.raw({type:'application/json'}), async (req,res) => {
  const store = await getOne('SELECT slug,payment_key FROM stores WHERE slug=$1',[slug.parse(req.params.store)]);
  if (!signed(decrypt(store?.payment_key),req)) return res.sendStatus(401);
  const {event,data} = JSON.parse(req.body);
  if (event === 'charge.success' && id.safeParse(data?.reference).success) await paidOrder(store,data.reference);
  res.sendStatus(200);
});

app.post('/hooks/paystack/platform', express.raw({type:'application/json'}), async (req,res) => {
  if (!signed(env.PLATFORM_PAYSTACK_SECRET,req)) return res.sendStatus(401);
  const {event,data} = JSON.parse(req.body);
  if (event === 'charge.success' && id.safeParse(data?.reference).success) await initialSubscription(data.reference);
  if (event === 'subscription.create' && data.plan?.plan_code === env.PLATFORM_PLAN_CODE) {
    await pool.query(`UPDATE stores SET subscription_code=$1 WHERE slug=(
      SELECT s.slug FROM stores s JOIN billing_links b ON b.store_slug=s.slug
      WHERE lower(s.email)=lower($2) AND s.subscription_code IS NULL AND b.plan=$3 LIMIT 1)`,
      [data.subscription_code,data.customer?.email,data.plan.plan_code]);
  }
  const code = data.subscription?.subscription_code || data.subscription_code;
  if (event === 'invoice.update' && data.paid && data.transaction?.reference && code) {
    const ref = data.transaction.reference;
    const store = await getOne(`SELECT s.slug,b.amount FROM stores s JOIN billing_links b ON b.store_slug=s.slug
      WHERE s.subscription_code=$1 AND b.paid_at IS NOT NULL LIMIT 1`,[code]);
    if (store && !await getOne('SELECT ref FROM billing_links WHERE ref::text=$1',[ref])) {
      const payment = await verify(env.PLATFORM_PAYSTACK_SECRET,ref);
      if (matches(payment,ref,store.amount)) await transaction(async db => {
        const result = await db.query('INSERT INTO billing_receipts VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING ref',[ref,store.slug]);
        if (result.rowCount) await db.query(`UPDATE stores SET access_until=GREATEST(now(),access_until)+interval '1 month',
          subscription_status='active' WHERE slug=$1`,[store.slug]);
      });
    }
  }
  const states = {'invoice.payment_failed':'past_due','subscription.not_renew':'non_renewing','subscription.disable':'cancelled'};
  if (Object.hasOwn(states,event) && code) await pool.query('UPDATE stores SET subscription_status=$2 WHERE subscription_code=$1',[code,states[event]]);
  res.sendStatus(200);
});

app.use(express.json({limit:'20kb'}));
app.use((req,res,next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/admin')) res.set('Cache-Control','no-store');
  if (req.method === 'POST' && req.get('origin') !== origin) return res.sendStatus(403);
  next();
});
const limited = rateLimit({windowMs:60000,limit:10});
const callbackLimit = rateLimit({windowMs:60000,limit:30});
app.get('/api/store/:store/payment/:ref',callbackLimit,async (req,res) => {
  const order = await getOne('SELECT paid_at FROM purchases WHERE store_slug=$1 AND ref=$2',
    [slug.parse(req.params.store),id.parse(req.params.ref)]);
  res.json({paid:Boolean(order?.paid_at)});
});
app.get('/api/store/:store', async (req,res) => {
  const key = slug.parse(req.params.store);
  const store = await getOne('SELECT slug,name,shipping_cents FROM stores WHERE slug=$1 AND '+enabled,[key]);
  if (!store) throw problem(404,'Store is unavailable.');
  const {rows:products} = await pool.query(`SELECT sku,name,size,notes,price_cents,image_position
    FROM products WHERE store_slug=$1 AND active ORDER BY image_position,sku`,[key]);
  res.json({store,products});
});

const checkout = z.object({
  name:label,email,phone:label,address:label,city:label,province:label,
  postcode:z.string().regex(/^\d{4}$/),
  items:z.array(z.object({sku,quantity:z.number().int().min(1).max(20)})).min(1).max(30)
});
app.post('/api/store/:store/checkout',limited,async (req,res) => {
  const {items,...customer} = checkout.parse(req.body);
  const store = await getOne('SELECT * FROM stores WHERE slug=$1 AND '+enabled,[slug.parse(req.params.store)]);
  if (!store) throw problem(404,'Store is unavailable.');
  const key = decrypt(store.payment_key);
  if (!key) throw problem(503,'Card payments are not configured.');
  const skus = items.map(item => item.sku);
  if (new Set(skus).size !== items.length) throw problem(400,'Duplicate products in bag.');
  const {rows} = await pool.query('SELECT sku,name,price_cents FROM products WHERE store_slug=$1 AND active AND sku=ANY($2)',[store.slug,skus]);
  if (rows.length !== items.length) throw problem(409,'A product is no longer available. Refresh your bag.');
  const lines = items.map(item => ({...rows.find(row => row.sku === item.sku),quantity:item.quantity}));
  const amount = lines.reduce((sum,line) => sum+line.price_cents*line.quantity,store.shipping_cents);
  const ref = randomUUID();
  await pool.query('INSERT INTO purchases(ref,store_slug,customer,items,shipping_cents,amount) VALUES($1,$2,$3,$4,$5,$6)',
    [ref,store.slug,JSON.stringify(customer),JSON.stringify(lines),store.shipping_cents,amount]);
  const data = await paystack(key,'/transaction/initialize',{email:customer.email,amount,currency:'ZAR',reference:ref,
    channels:['card'],callback_url:origin+'/payment/'+store.slug});
  res.json({url:data.authorization_url});
});

app.get('/payment/:store',callbackLimit,async (req,res) => {
  const store = await getOne('SELECT slug,payment_key FROM stores WHERE slug=$1',[slug.parse(req.params.store)]);
  const ref = id.parse(req.query.reference);
  if (store) {
    try { await paidOrder(store,ref); }
    catch (error) { console.error('Payment verification pending',error.name); }
  }
  res.redirect('/?store='+req.params.store+'&payment='+ref);
});

app.post('/api/store/:store/contact',limited,async (req,res) => {
  const data = z.object({name:label,email,message:z.string().trim().min(5).max(2000),website:z.string().max(500).optional()}).parse(req.body);
  if (!data.website) {
    const key = slug.parse(req.params.store);
    const store = await getOne('SELECT slug FROM stores WHERE slug=$1 AND '+enabled,[key]);
    if (!store) throw problem(404,'Store is unavailable.');
    const ref = randomUUID();
    await transaction(async db => {
      await db.query('INSERT INTO contacts(id,store_slug,details) VALUES($1,$2,$3)',[ref,key,JSON.stringify(data)]);
      await notify(db,key,'contact',ref);
    });
  }
  res.status(201).json({ok:true});
});

const hash = value => createHash('sha256').update(value).digest();
function admin(req,res,next) {
  const password = env.ADMIN_PASSWORD;
  const auth = (req.get('authorization') || '').match(/^Basic (.+)$/i);
  const supplied = auth ? Buffer.from(auth[1],'base64').toString('utf8') : '';
  if (password?.length >= 20 && timingSafeEqual(hash(supplied),hash('admin:'+password))) return next();
  res.set('WWW-Authenticate','Basic realm="LiboTech Administration", charset="UTF-8"').sendStatus(401);
}

app.use(['/admin','/api/admin'],rateLimit({windowMs:60000,limit:100}),admin);
app.get('/api/admin',async (_req,res) => {
  const results = await Promise.all([
    pool.query(`SELECT slug,name,email,whatsapp,shipping_cents,enabled,access_until,subscription_status,subscription_code
      FROM stores ORDER BY slug`),
    pool.query('SELECT * FROM purchases WHERE paid_at IS NOT NULL ORDER BY paid_at DESC LIMIT 100'),
    pool.query('SELECT * FROM contacts ORDER BY created_at DESC LIMIT 100'),
    pool.query('SELECT * FROM notifications WHERE sent_at IS NULL AND attempts>0 ORDER BY id DESC LIMIT 100'),
    pool.query('SELECT * FROM products ORDER BY store_slug,image_position,sku')
  ]);
  res.json(Object.fromEntries(['stores','orders','contacts','notifications','products'].map((key,i) => [key,results[i].rows])));
});
app.post('/api/admin/store',async (req,res) => {
  const data = z.object({slug,name:label,email,whatsapp,shipping_cents:money,enabled:z.boolean(),
    payment_key:z.string().regex(/^sk_(test|live)_[A-Za-z0-9]+$/).optional()}).parse(req.body);
  if (data.slug !== 'nocturne' && await getOne(`SELECT 1 FROM stores s JOIN billing_links b ON b.store_slug=s.slug
    WHERE s.slug=$1 AND lower(s.email)<>lower($2)`,[data.slug,data.email]))
    throw problem(409,'A billing link already exists for this email. Reconcile the account in Paystack before changing it.');
  if (data.slug !== 'nocturne' && await getOne('SELECT slug FROM stores WHERE lower(email)=lower($1) AND slug<>$2',[data.email,data.slug]))
    throw problem(409,'Use a unique billing email per store.');
  await pool.query(`INSERT INTO stores(slug,name,email,whatsapp,shipping_cents,enabled,payment_key) VALUES($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (slug) DO UPDATE SET name=excluded.name,email=excluded.email,whatsapp=excluded.whatsapp,
    shipping_cents=excluded.shipping_cents,enabled=excluded.enabled,payment_key=COALESCE(excluded.payment_key,stores.payment_key)`,
    [data.slug,data.name,data.email,data.whatsapp,data.shipping_cents,data.enabled,encrypt(data.payment_key)]);
  res.json({ok:true});
});
app.post('/api/admin/product',async (req,res) => {
  const d = z.object({store_slug:slug,sku,name:label,size:label,notes:z.string().trim().min(1).max(500),
    price_cents:money.min(1),image_position:z.number().int().min(0).max(100),active:z.boolean()}).parse(req.body);
  await pool.query(`INSERT INTO products VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (store_slug,sku)
    DO UPDATE SET name=excluded.name,size=excluded.size,notes=excluded.notes,price_cents=excluded.price_cents,
    image_position=excluded.image_position,active=excluded.active`,
    [d.store_slug,d.sku,d.name,d.size,d.notes,d.price_cents,d.image_position,d.active]);
  res.json({ok:true});
});
app.post('/api/admin/billing',async (req,res) => {
  const store = await getOne(`SELECT * FROM stores WHERE slug=$1 AND subscription_status='pending' AND subscription_code IS NULL`,[slug.parse(req.body.slug)]);
  if (!store) throw problem(409,'Only a new client can start a subscription here.');
  const amount = money.min(1).parse(Number(env.PLATFORM_MONTHLY_CENTS));
  const plan = env.PLATFORM_PLAN_CODE;
  if (!plan) throw problem(503,'Configure a monthly Paystack plan.');
  const planDetails = await paystack(env.PLATFORM_PAYSTACK_SECRET,'/plan/'+encodeURIComponent(plan));
  if (planDetails.currency !== 'ZAR' || planDetails.interval !== 'monthly' || planDetails.amount !== amount)
    throw problem(409,'Paystack plan must match the configured monthly amount in ZAR.');
  const previous = await getOne('SELECT authorization_url FROM billing_links WHERE store_slug=$1',[store.slug]);
  if (previous?.authorization_url) return res.json({url:previous.authorization_url});
  const ref = randomUUID();
  const link = await transaction(async db => {
    await db.query('SELECT slug FROM stores WHERE slug=$1 FOR UPDATE',[store.slug]);
    const existing = await db.query('SELECT ref FROM billing_links WHERE store_slug=$1',[store.slug]);
    if (existing.rowCount) throw problem(409,'A billing link already exists. Check the client and Paystack before issuing another.');
    await db.query('INSERT INTO billing_links(ref,store_slug,amount,plan) VALUES($1,$2,$3,$4)',[ref,store.slug,amount,plan]);
    return ref;
  });
  const result = await paystack(env.PLATFORM_PAYSTACK_SECRET,'/transaction/initialize',{email:store.email,amount,currency:'ZAR',
    channels:['card'],plan,reference:link,callback_url:origin+'/billing-return'});
  await pool.query('UPDATE billing_links SET authorization_url=$2 WHERE ref=$1',[link,result.authorization_url]);
  res.json({url:result.authorization_url});
});
app.post('/api/admin/billing/manage',async (req,res) => {
  const store = await getOne('SELECT subscription_code FROM stores WHERE slug=$1',[slug.parse(req.body.slug)]);
  if (!store?.subscription_code) throw problem(404,'No Paystack subscription is linked.');
  const result = await paystack(env.PLATFORM_PAYSTACK_SECRET,'/subscription/'+encodeURIComponent(store.subscription_code)+'/manage/link');
  res.json({url:result.link});
});
app.get('/billing-return',callbackLimit,async (req,res) => {
  const paid = await initialSubscription(id.parse(req.query.reference));
  res.type('text').send(paid ? 'Subscription payment confirmed.' : 'Subscription payment is awaiting confirmation.');
});
app.post('/api/admin/ship',async (req,res) => {
  await pool.query('UPDATE purchases SET shipped_at=COALESCE(shipped_at,now()) WHERE ref=$1 AND paid_at IS NOT NULL',[id.parse(req.body.ref)]);
  res.json({ok:true});
});
app.post('/api/admin/retry',async (req,res) => {
  const notification = z.string().regex(/^\d{1,18}$/).parse(req.body.id);
  await pool.query('UPDATE notifications SET attempts=0,next_attempt=now() WHERE id=$1 AND sent_at IS NULL',[notification]);
  res.json({ok:true});
});
app.get('/admin/dashboard.js',(_req,res) => res.sendFile(fileURLToPath(new URL('./private/dashboard.js',import.meta.url))));
app.get('/admin',(_req,res) => res.sendFile(fileURLToPath(new URL('./private/admin.html',import.meta.url))));
app.use(express.static(fileURLToPath(new URL('./public',import.meta.url)),{redirect:false}));
app.use((err,_req,res,_next) => {
  const status = err instanceof z.ZodError ? 400 : Number.isInteger(err.status) ? err.status : 500;
  if (status === 500) console.error(err.name,err.code || '');
  res.status(status).json({error:status===400?'Check the information you entered.':status===500?'Something went wrong.':err.message});
});
await pool.query('SELECT 1 FROM stores LIMIT 1');
app.listen(Number(env.PORT || 3000),() => console.log('Nocturne listening on '+origin));
startNotifications();
