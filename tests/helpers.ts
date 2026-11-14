import request from 'supertest';
import bcrypt from 'bcryptjs';
import { app } from '../src/app';
import { pool } from '../src/db/pool';
import { sign } from '../src/modules/kyc/signature';

// empty every table so each test starts clean
export async function resetDb() {
  // audit_events has a trigger that blocks DELETE, but TRUNCATE is not blocked by row triggers
  await pool.query(
    'TRUNCATE kyc_callbacks, kyc_verifications, audit_events, merchants, users RESTART IDENTITY CASCADE'
  );
}

export async function seedUsers() {
  const hash = await bcrypt.hash('Demo@1234', 4); // low cost, tests only
  const users = [
    ['merchant1@test.dev', 'MERCHANT'],
    ['merchant2@test.dev', 'MERCHANT'],
    ['maker1@test.dev', 'MAKER'],
    ['checker1@test.dev', 'CHECKER'],
    ['admin1@test.dev', 'ADMIN'],
  ];
  for (const [email, role] of users) {
    await pool.query('INSERT INTO users (email, password_hash, role) VALUES ($1,$2,$3)', [email, hash, role]);
  }
}

export async function login(email: string): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ email, password: 'Demo@1234' });
  return res.body.token;
}

export function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

// builds a signed callback the same way the provider would
export function signedCallback(payload: object) {
  const body = JSON.stringify(payload);
  return request(app)
    .post('/api/kyc/callback')
    .set('Content-Type', 'application/json')
    .set('X-Signature', sign(body))
    .send(body);
}

export const samplePan = (n: number) => `ABCDE${String(1000 + n)}F`;

export async function createMerchant(token: string, n: number) {
  const res = await request(app)
    .post('/api/merchants')
    .set(auth(token))
    .send({
      businessName: `Test Shop ${n}`,
      businessType: 'SOLE_PROPRIETOR',
      contactEmail: `shop${n}@test.dev`,
      contactPhone: '9876543210',
      pan: samplePan(n),
    });
  return res;
}

export async function closePool() {
  await pool.end();
}