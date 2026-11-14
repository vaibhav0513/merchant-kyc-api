import bcrypt from 'bcryptjs';
import { pool } from '../src/db/pool';

const users = [
  { email: 'merchant1@demo.test', role: 'MERCHANT' },
  { email: 'merchant2@demo.test', role: 'MERCHANT' },
  { email: 'maker1@demo.test', role: 'MAKER' },
  { email: 'maker2@demo.test', role: 'MAKER' },
  { email: 'checker1@demo.test', role: 'CHECKER' },
  { email: 'admin1@demo.test', role: 'ADMIN' },
];

async function seed() {
  // demo password only, for synthetic users
  const hash = await bcrypt.hash('Demo@1234', 10);

  for (const u of users) {
    // ON CONFLICT makes the seed safe to run more than once
    await pool.query(
      `INSERT INTO users (email, password_hash, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (email) DO NOTHING`,
      [u.email, hash, u.role]
    );
  }

  console.log('seeded', users.length, 'users');
  await pool.end();
}

seed();