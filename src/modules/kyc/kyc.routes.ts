import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../../db/pool';
import { withTx } from '../../db/tx';
import { authenticate, requireRole } from '../../middleware/auth';
import { HttpError } from '../../middleware/errors';
import { writeAudit, assertTransition, Status } from '../merchants/workflow';
import { callProvider } from './provider';

export const kycRouter = Router();
kycRouter.use(authenticate);

const verifySchema = z.object({
  merchantId: z.number().int().positive(),
  identityRef: z.string().trim().min(4).max(20), // fictional identity reference
});

// how a provider outcome maps to our statuses
const outcomeToKyc: Record<string, 'VERIFIED' | 'FAILED' | 'PENDING' | 'UNKNOWN'> = {
  SUCCESS: 'VERIFIED',
  FAILED: 'FAILED',
  PENDING: 'PENDING',
  TIMEOUT: 'UNKNOWN', // a timeout is never "verified"
};

kycRouter.post('/verify', requireRole('MAKER', 'ADMIN'), async (req, res, next) => {
  try {
    const parsed = verifySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }
    const { merchantId, identityRef } = parsed.data;
    const user = req.user!;
    const idemKey = (req.header('Idempotency-Key') || '').trim() || null;

    // 1. repeated request with the same key: return the saved result, no provider call
    if (idemKey) {
      const prev = await pool.query(
        'SELECT * FROM kyc_verifications WHERE requested_by = $1 AND idempotency_key = $2',
        [user.id, idemKey]
      );
      if (prev.rowCount) return res.json(toResponse(prev.rows[0], true));
    }

    // 2. reserve the slot in the DB first, so concurrent requests can't both call the provider
    const pending = await withTx(async (db) => {
      const found = await db.query('SELECT * FROM merchants WHERE id = $1 FOR UPDATE', [merchantId]);
      const m = found.rows[0];
      if (!m) throw new HttpError(404, 'Merchant not found');
      if (m.status !== 'SUBMITTED') throw new HttpError(409, 'Merchant must be SUBMITTED to verify');

      const open = await db.query(
        "SELECT 1 FROM kyc_verifications WHERE merchant_id = $1 AND status IN ('PENDING','UNKNOWN')",
        [merchantId]
      );
      if (open.rowCount) throw new HttpError(409, 'A verification is already in progress');

      assertTransition(m.status as Status, 'VERIFYING');
      await db.query(
        "UPDATE merchants SET status = 'VERIFYING', kyc_status = 'PENDING', updated_at = now() WHERE id = $1",
        [merchantId]
      );
      await writeAudit(db, { merchantId, actorId: user.id, action: 'KYC_STARTED', from: 'SUBMITTED', to: 'VERIFYING' });
      return true;
    });
    void pending;

    // 3. call the provider outside the transaction (it can be slow)
    const result = await callProvider(identityRef);
    const kyc = outcomeToKyc[result.outcome];

    // 4. save the result, always with the provider reference
    const saved = await withTx(async (db) => {
      const ins = await db.query(
        `INSERT INTO kyc_verifications (merchant_id, provider_ref, status, idempotency_key, requested_by)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [merchantId, result.providerRef, kyc === 'VERIFIED' || kyc === 'FAILED' ? kyc : kyc, idemKey, user.id]
      );
      await applyKycResult(db, merchantId, kyc, user.id);
      return ins.rows[0];
    });

    res.status(201).json(toResponse(saved, false));
  } catch (err: any) {
    // two requests with the same idempotency key at the same moment
    if (err.code === '23505') return next(new HttpError(409, 'Duplicate request'));
    next(err);
  }
});

// updates the merchant after a KYC outcome. Used by verify and by the callback.
export async function applyKycResult(db: any, merchantId: number, kyc: string, actorId: number) {
  if (kyc === 'PENDING') return; // stay in VERIFYING, wait for the callback

  // VERIFIED, FAILED and UNKNOWN all go to REVIEW_REQUIRED. A human decides.
  assertTransition('VERIFYING', 'REVIEW_REQUIRED');
  await db.query(
    "UPDATE merchants SET status = 'REVIEW_REQUIRED', kyc_status = $1, updated_at = now() WHERE id = $2",
    [kyc, merchantId]
  );
  await writeAudit(db, {
    merchantId, actorId, action: 'KYC_RESULT_' + kyc, from: 'VERIFYING', to: 'REVIEW_REQUIRED',
  });
}

function toResponse(row: any, replay: boolean) {
  return {
    verificationId: row.id,
    merchantId: row.merchant_id,
    providerRef: row.provider_ref,
    status: row.status,
    idempotentReplay: replay,
  };
}