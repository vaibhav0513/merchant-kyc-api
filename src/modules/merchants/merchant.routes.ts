import { Router } from 'express';
import { pool } from '../../db/pool';
import { authenticate, requireRole } from '../../middleware/auth';
import { encrypt, hmacHash } from '../../utils/crypto';
import { maskPan } from '../../utils/mask';
import { createMerchantSchema } from './merchant.schema';

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