import fs from 'fs';
import path from 'path';
import { pool } from './pool';

async function migrate() {
  // table that remembers which files we already ran
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const dir = path.join(__dirname, '..', '..', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    const done = await pool.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [file]);
    if (done.rowCount) continue;

    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      // run the file and the bookkeeping insert together, so a failure rolls back both
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log('applied', file);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('failed on', file, (err as Error).message);
      process.exit(1);
    } finally {
      client.release();
    }
  }

  await pool.end();
}

migrate();