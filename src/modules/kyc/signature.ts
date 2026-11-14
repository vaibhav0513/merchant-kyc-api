import crypto from 'crypto';
import { config } from '../../config/env';

// the provider signs the raw body with the shared secret
export function sign(rawBody: string): string {
  return crypto.createHmac('sha256', config.kycCallbackSecret).update(rawBody).digest('hex');
}

export function verifySignature(rawBody: string, signature: string): boolean {
  const expected = Buffer.from(sign(rawBody), 'hex');
  const given = Buffer.from(signature || '', 'hex');
  // timingSafeEqual throws if lengths differ, so check first
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}