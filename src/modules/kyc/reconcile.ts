import { pool } from '../../db/pool';
import { withTx } from '../../db/tx';
import { logger } from '../../utils/logger';
import { writeAudit } from '../merchants/workflow';
import { applyKycResult } from './kyc.routes';

export type ProviderOutcome = 'SUCCESS' | 'FAILED' | 'PENDING' | 'TIMEOUT';

// mock status check. A real provider would be an HTTPS call using the providerRef.
export async function checkProviderStatus(_providerRef: string): Promise<ProviderOutcome> {
  return 'SUCCESS';
}

const toKyc = { SUCCESS: 'VERIFIED', FAILED: 'FAILED' } as const;

type Options = {
  olderThanMs?: number;
  check?: (providerRef: string) => Promise<ProviderOutcome>;
};

// one pass over everything that looks stuck
export async function reconcileOnce(opts: Options = {}) {
  const olderThanSecs = (opts.olderThanMs ?? 5 * 60 * 1000) / 1000;
  const check = opts.check ?? checkProviderStatus;
  let resolved = 0;
  let orphans = 0;

  // 1. verifications that never got a final answer
  const stale = await pool.query(
    `SELECT id, provider_ref FROM kyc_verifications
     WHERE status IN ('PENDING','UNKNOWN') AND updated_at < now() - make_interval(secs => $1)
     ORDER BY id LIMIT 50`,
    [olderThanSecs]
  );

  for (const row of stale.rows) {
    let outcome: ProviderOutcome;
    try {
      outcome = await check(row.provider_ref);
    } catch (e) {
      logger.error('status check failed:', { message: (e as Error).message });
      continue; // try again on the next pass
    }
    // still pending or timed out: leave it alone, never mark verified
    if (outcome !== 'SUCCESS' && outcome !== 'FAILED') continue;
    const kyc = toKyc[outcome];

    const done = await withTx<boolean>(async (db) => {
      // same lock the callback takes, then re-check, in case a callback got there first
      const v = (await db.query('SELECT * FROM kyc_verifications WHERE id = $1 FOR UPDATE', [row.id])).rows[0];
      if (!v || !['PENDING', 'UNKNOWN'].includes(v.status)) return false;

      await db.query('UPDATE kyc_verifications SET status = $1, updated_at = now() WHERE id = $2', [kyc, v.id]);

      const m = (await db.query('SELECT * FROM merchants WHERE id = $1 FOR UPDATE', [v.merchant_id])).rows[0];
      if (m.status === 'VERIFYING') {
        await applyKycResult(db, m.id, kyc, v.requested_by);
      } else if (m.status === 'REVIEW_REQUIRED') {
        await db.query('UPDATE merchants SET kyc_status = $1, updated_at = now() WHERE id = $2', [kyc, m.id]);
      }
      return true;
    });
    if (done) resolved++;
  }

  // 2. merchants stuck in VERIFYING with no pending verification (the save failed after the provider answered)
  const stuck = await pool.query(
    `SELECT id FROM merchants m
     WHERE m.status = 'VERIFYING' AND m.updated_at < now() - make_interval(secs => $1)
       AND NOT EXISTS (SELECT 1 FROM kyc_verifications v WHERE v.merchant_id = m.id AND v.status = 'PENDING')
     ORDER BY id LIMIT 50`,
    [olderThanSecs]
  );

  for (const row of stuck.rows) {
    const done = await withTx<boolean>(async (db) => {
      const m = (await db.query('SELECT * FROM merchants WHERE id = $1 FOR UPDATE', [row.id])).rows[0];
      if (!m || m.status !== 'VERIFYING') return false;
      const open = await db.query(
        "SELECT 1 FROM kyc_verifications WHERE merchant_id = $1 AND status = 'PENDING'", [m.id]
      );
      if (open.rowCount) return false;

      // a human decides; KYC stays unverified so approve is blocked
      await db.query(
        "UPDATE merchants SET status = 'REVIEW_REQUIRED', kyc_status = 'UNKNOWN', updated_at = now() WHERE id = $1",
        [m.id]
      );
      await writeAudit(db, {
        merchantId: m.id, actorId: m.last_modified_by, action: 'KYC_RECONCILED_UNKNOWN',
        from: 'VERIFYING', to: 'REVIEW_REQUIRED', reason: 'No provider result was saved',
      });
      return true;
    });
    if (done) orphans++;
  }

  return { resolved, orphans };
}

// runs reconcileOnce on a timer. Started from server.ts only, never in tests.
export function startReconciler() {
  const everyMs = (Number(process.env.RECONCILE_INTERVAL_SECONDS) || 60) * 1000;
  let running = false;

  const timer = setInterval(async () => {
    if (running) return; // don't overlap passes
    running = true;
    try {
      const r = await reconcileOnce();
      if (r.resolved || r.orphans) logger.info('reconciler fixed items', r);
    } catch (e) {
      logger.error('reconciler failed:', { message: (e as Error).message });
    } finally {
      running = false;
    }
  }, everyMs);
  timer.unref();
}