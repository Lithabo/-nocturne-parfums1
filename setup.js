import { readFile } from 'node:fs/promises';
import { pool, encrypt, transaction } from './db.js';
try {
  await transaction(async db => {
    await db.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
    await db.query(
      `INSERT INTO stores(slug,name,email,whatsapp,payment_key,shipping_cents,enabled,subscription_status)
       VALUES ('nocturne','Nocturne Parfums',$1,$2,$3,$4,true,'owned')
       ON CONFLICT (slug) DO UPDATE SET email=excluded.email,whatsapp=excluded.whatsapp,
       payment_key=excluded.payment_key,shipping_cents=excluded.shipping_cents`,
      [process.env.NOCTURNE_EMAIL || '', process.env.NOCTURNE_WHATSAPP || '',
        encrypt(process.env.NOCTURNE_PAYSTACK_SECRET), Number(process.env.NOCTURNE_SHIPPING_CENTS || 0)]
    );
    await db.query(`INSERT INTO products VALUES
      ('nocturne','edp','Eau de Parfum','75 ml','Juniper, cedar and amber.',245000,0,true),
      ('nocturne','mist','Hair Mist','30 ml','Soft amber and a touch of juniper.',85000,50,true),
      ('nocturne','solid','Solid Perfume','3 g','A pocket-sized balm with cedar and soft amber.',69000,100,true)
      ON CONFLICT DO NOTHING`);
  });
  console.log('Database is ready.');
} finally {
  await pool.end();
}
