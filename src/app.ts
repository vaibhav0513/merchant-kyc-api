import express from 'express';
import { pool } from './db/pool';
import { authRouter } from './modules/auth/auth.routes';
import { errorHandler } from './middleware/errors';
import { logger } from './utils/logger';
import { merchantRouter } from './modules/merchants/merchant.routes';
import { kycRouter } from './modules/kyc/kyc.routes';
import { callbackRouter } from './modules/kyc/callback.routes';

export const app = express();

// one JSON parser, which also keeps the raw body for signature checks
app.use(express.json({
  verify: (req: any, _res, buf) => { req.rawBody = buf.toString('utf8'); },
}));

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch (err) {
    logger.error('health check failed:', { message: (err as Error).message });
    res.status(503).json({ status: 'db_unavailable' });
  }
});

app.use('/api/auth', authRouter);
app.use('/api/merchants', merchantRouter);

// callback first: it is signed by the provider, not logged-in. Then the authenticated routes.
app.use('/api/kyc', callbackRouter);
app.use('/api/kyc', kycRouter);

app.use(errorHandler);