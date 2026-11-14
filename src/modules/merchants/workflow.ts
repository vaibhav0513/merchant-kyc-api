import { HttpError } from '../../middleware/errors';

export type Status = 'DRAFT' | 'SUBMITTED' | 'VERIFYING' | 'REVIEW_REQUIRED' | 'APPROVED' | 'REJECTED';

// the only moves the system allows
const transitions: Record<Status, Status[]> = {
  DRAFT: ['SUBMITTED'],
  SUBMITTED: ['VERIFYING'],
  VERIFYING: ['REVIEW_REQUIRED'],
  REVIEW_REQUIRED: ['APPROVED', 'REJECTED', 'DRAFT'],
  APPROVED: [],
  REJECTED: [],
};

export function assertTransition(from: Status, to: Status) {
  if (!transitions[from].includes(to)) {
    throw new HttpError(409, `Invalid transition ${from} -> ${to}`);
  }
}

// works with a pool or a transaction client
export async function writeAudit(
  db: { query: (sql: string, params: any[]) => Promise<any> },
  e: { merchantId: number; actorId: number; action: string; from: string | null; to: string | null; reason?: string }
) {
  await db.query(
    `INSERT INTO audit_events (merchant_id, actor_id, action, from_status, to_status, reason)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [e.merchantId, e.actorId, e.action, e.from, e.to, e.reason ?? null]
  );
}