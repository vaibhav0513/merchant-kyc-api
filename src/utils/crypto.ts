import crypto from 'crypto';
import { config } from '../config/env';

const encKey = Buffer.from(config.panEncKey, 'base64');
const hashKey = Buffer.from(config.panHashKey, 'base64');

if (encKey.length !== 32) throw new Error('PAN_ENC_KEY must be 32 bytes (base64)');

// AES-256-GCM: encrypts and also detects tampering
export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12); // fresh IV every time, never reuse
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // keep everything needed to decrypt in one string
  return [iv, tag, data].map((b) => b.toString('base64')).join('.');
}

export function decrypt(stored: string): string {
  const [iv, tag, data] = stored.split('.').map((s) => Buffer.from(s, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', encKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

// HMAC "blind index": same input always gives the same output,
// so we can check duplicates without decrypting anything
export function hmacHash(value: string): string {
  return crypto.createHmac('sha256', hashKey).update(value.toUpperCase()).digest('hex');
}