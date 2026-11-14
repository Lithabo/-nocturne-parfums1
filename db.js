import pg from 'pg';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

function encryptionKey() {
  const key = Buffer.from(process.env.STORE_ENCRYPTION_KEY || '', 'base64');
  if (key.length !== 32) throw new Error('Configure STORE_ENCRYPTION_KEY');
  return key;
}

export function encrypt(value) {
  if (!value) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  return [iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()].map(part => part.toString('base64')).join('.');
}

export function decrypt(value) {
  if (!value) return null;
  const [iv, data, end, tag] = value.split('.').map(part => Buffer.from(part, 'base64'));
  const cipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(data), cipher.update(end), cipher.final()]).toString('utf8');
}

export async function transaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
