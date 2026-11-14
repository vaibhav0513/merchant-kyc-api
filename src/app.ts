import express from 'express';
import { pool } from './db/pool';

export const app = express();

app.use(express.json());

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('health check failed:', (err as Error).message);
    res.status(503).json({ status: 'db_unavailable' });
  }
});