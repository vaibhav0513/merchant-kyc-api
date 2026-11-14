import express from 'express';
import { pool } from './db/pool';
import { authRouter } from './modules/auth/auth.routes';
import { authenticate, requireRole } from './middleware/auth';
import { errorHandler } from './middleware/errors';
import { logger } from './utils/logger';

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


app.use('/api/auth', authRouter);

// temporary routes to test the middleware, we remove them later
app.get('/api/whoami', authenticate, (req, res) => res.json(req.user));
app.get('/api/checker-only', authenticate, requireRole('CHECKER'), (_req, res) => res.json({ ok: true }));

app.use(errorHandler);