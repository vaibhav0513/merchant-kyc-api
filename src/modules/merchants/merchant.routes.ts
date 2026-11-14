import { Router } from 'express';
import { pool } from '../../db/pool';
import { authenticate, requireRole } from '../../middleware/auth';
import { encrypt, hmacHash } from '../../utils/crypto';
import { maskPan } from '../../utils/mask';
import { createMerchantSchema } from './merchant.schema';
import { withTx } from '../../db/tx';
import { HttpError } from '../../middleware/errors';
import { assertTransition, writeAudit, Status } from './workflow';
import { updateMerchantSchema, reviewSchema } from './merchant.schema';


export const merchantRouter = Router();

merchantRouter.use(authenticate);

// turn a DB row into a safe API response: no encrypted value, no hash, only masked PAN
function toResponse(row: any) {
  return {
    id: row.id,
    businessName: row.business_name,
    businessType: row.business_type,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    pan: 'XXXXX' + row.pan_last4 + 'X',
    status: row.status,
    kycStatus: row.kyc_status,
    createdAt: row.created_at,
  };
}

// Merchants create their own application. Makers create on behalf of a merchant.
merchantRouter.post('/', requireRole('MERCHANT', 'MAKER'), async (req, res, next) => {
  try {
    const parsed = createMerchantSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }
    const d = parsed.data;
    const user = req.user!;

    // a maker must say which merchant user the application belongs to
    let ownerId = user.id;
    if (user.role === 'MAKER') {
      const ownerEmail = req.body.ownerEmail;
      const owner = await pool.query("SELECT id FROM users WHERE email = $1 AND role = 'MERCHANT'", [ownerEmail]);
      if (!owner.rowCount) return res.status(400).json({ error: 'ownerEmail must be an existing merchant user' });
      ownerId = owner.rows[0].id;
    }

    try {
      const result = await pool.query(
        `INSERT INTO merchants
           (business_name, business_type, contact_email, contact_phone,
            pan_encrypted, pan_hash, pan_last4, owner_id, created_by, last_modified_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
         RETURNING *`,
        [d.businessName, d.businessType, d.contactEmail, d.contactPhone,
         encrypt(d.pan), hmacHash(d.pan), d.pan.slice(5, 9), ownerId, user.id]
      );
      res.status(201).json(toResponse(result.rows[0]));
    } catch (err: any) {
      // 23505 = unique violation, the DB caught a duplicate PAN
      if (err.code === '23505') {
        return res.status(409).json({ error: 'An application with this PAN already exists' });
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});


// merchants only touch their own application; Maker/Admin can act on any
function assertCanEdit(row: any, user: { id: number; role: string }) {
  if (!row) throw new HttpError(404, 'Merchant not found');
  if (user.role === 'MERCHANT' && row.owner_id !== user.id) {
    throw new HttpError(404, 'Merchant not found');
  }
}

// edit basic details, only while the application is a DRAFT
merchantRouter.patch('/:id', requireRole('MERCHANT', 'MAKER', 'ADMIN'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });

    const parsed = updateMerchantSchema.safeParse(req.body);
    if (!parsed.success || Object.keys(parsed.data).length === 0) {
      return res.status(400).json({ error: 'Validation failed' });
    }
    const d = parsed.data;
    const user = req.user!;

    const updated = await withTx(async (db) => {
      const found = await db.query('SELECT * FROM merchants WHERE id = $1 FOR UPDATE', [id]);
      const row = found.rows[0];
      assertCanEdit(row, user);
      if (row.status !== 'DRAFT') throw new HttpError(409, 'Only DRAFT applications can be edited');

      const result = await db.query(
        `UPDATE merchants SET
           business_name = COALESCE($1, business_name),
           business_type = COALESCE($2, business_type),
           contact_email = COALESCE($3, contact_email),
           contact_phone = COALESCE($4, contact_phone),
           last_modified_by = $5,
           updated_at = now()
         WHERE id = $6 RETURNING *`,
        [d.businessName ?? null, d.businessType ?? null, d.contactEmail ?? null, d.contactPhone ?? null, user.id, id]
      );
      await writeAudit(db, { merchantId: id, actorId: user.id, action: 'EDIT', from: 'DRAFT', to: 'DRAFT' });
      return result.rows[0];
    });

    res.json(toResponse(updated));
  } catch (err) {
    next(err);
  }
});

merchantRouter.post('/:id/submit', requireRole('MERCHANT', 'MAKER', 'ADMIN'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
    const user = req.user!;

    const updated = await withTx(async (db) => {
      const found = await db.query('SELECT * FROM merchants WHERE id = $1 FOR UPDATE', [id]);
      const row = found.rows[0];
      assertCanEdit(row, user);
      assertTransition(row.status as Status, 'SUBMITTED');

      const result = await db.query(
        `UPDATE merchants SET status = 'SUBMITTED', submitted_by = $1, last_modified_by = $1, updated_at = now()
         WHERE id = $2 RETURNING *`,
        [user.id, id]
      );
      await writeAudit(db, { merchantId: id, actorId: user.id, action: 'SUBMIT', from: row.status, to: 'SUBMITTED' });
      return result.rows[0];
    });

    res.json(toResponse(updated));
  } catch (err) {
    next(err);
  }
});

merchantRouter.post('/:id/review', requireRole('CHECKER', 'ADMIN'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });

    const parsed = reviewSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }
    const { action, reason } = parsed.data;
    const user = req.user!;

    const target: Record<string, Status> = { APPROVE: 'APPROVED', REJECT: 'REJECTED', REQUEST_CHANGES: 'DRAFT' };

    const updated = await withTx(async (db) => {
      // FOR UPDATE locks the row, so two simultaneous reviews run one after the other
      const found = await db.query('SELECT * FROM merchants WHERE id = $1 FOR UPDATE', [id]);
      const row = found.rows[0];
      if (!row) throw new HttpError(404, 'Merchant not found');

      // maker-checker: anyone who touched the application cannot review it
      const touchedBy = [row.created_by, row.last_modified_by, row.submitted_by];
      if (touchedBy.includes(user.id)) {
        throw new HttpError(403, 'You worked on this application, so you cannot review it');
      }

      assertTransition(row.status as Status, target[action]);

      // never approve unless KYC really came back verified
      if (action === 'APPROVE' && row.kyc_status !== 'VERIFIED') {
        throw new HttpError(409, 'Cannot approve: KYC is not verified');
      }

      const result = await db.query(
        'UPDATE merchants SET status = $1, updated_at = now() WHERE id = $2 RETURNING *',
        [target[action], id]
      );
      await writeAudit(db, { merchantId: id, actorId: user.id, action, from: row.status, to: target[action], reason });
      return result.rows[0];
    });

    res.json(toResponse(updated));
  } catch (err) {
    next(err);
  }
});

// staff can read the audit trail of an application
merchantRouter.get('/:id/audit', requireRole('MAKER', 'CHECKER', 'ADMIN'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT actor_id, action, from_status, to_status, reason, created_at
       FROM audit_events WHERE merchant_id = $1 ORDER BY id`,
      [Number(req.params.id)]
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});


// Ownership check lives here, on the server, not in the client
merchantRouter.get('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });

    const result = await pool.query('SELECT * FROM merchants WHERE id = $1', [id]);
    const row = result.rows[0];
    const user = req.user!;

    // merchants only see their own; staff roles can see all
    const isStaff = ['MAKER', 'CHECKER', 'ADMIN'].includes(user.role);
    if (!row || (!isStaff && row.owner_id !== user.id)) {
      // same 404 for "missing" and "not yours", so ids can't be probed
      return res.status(404).json({ error: 'Merchant not found' });
    }

    res.json(toResponse(row));
  } catch (err) {
    next(err);
  }
});