import { Router } from "express";
import { z } from "zod";
import { withTx } from "../../db/tx";
import { verifySignature } from "./signature";
import { applyKycResult } from "./kyc.routes";
import { logger } from "../../utils/logger";

export const callbackRouter = Router();

const callbackSchema = z.object({
  eventId: z.string().min(1).max(100),
  providerRef: z.string().min(1).max(100),
  outcome: z.enum(["SUCCESS", "FAILED"]),
});

const outcomeToKyc = { SUCCESS: "VERIFIED", FAILED: "FAILED" } as const;

type CallbackResult = {
  unknown?: boolean;
  duplicate?: boolean;
  ignored?: boolean;
  applied?: boolean;
};

callbackRouter.post("/callback", async (req: any, res, next) => {
  try {
    // 1. check the signature first, before touching anything
    if (!verifySignature(req.rawBody || "", req.header("X-Signature") || "")) {
      logger.error("kyc callback rejected: bad signature");
      return res.status(401).json({ error: "Invalid signature" });
    }

    const parsed = callbackSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Validation failed" });
    }
    const { eventId, providerRef, outcome } = parsed.data;

    const result = await withTx<CallbackResult>(async (db) => {
      // 2. find the verification and lock it. Duplicate callbacks queue here.
      const found = await db.query(
        "SELECT * FROM kyc_verifications WHERE provider_ref = $1 FOR UPDATE",
        [providerRef],
      );
      const v = found.rows[0];
      if (!v) return { unknown: true };

      // 3. duplicate check: the PRIMARY KEY on event_id allows each event only once
      const ins = await db.query(
        `INSERT INTO kyc_callbacks (event_id, provider_ref, outcome)
         VALUES ($1,$2,$3) ON CONFLICT (event_id) DO NOTHING`,
        [eventId, providerRef, outcome],
      );
      if (!ins.rowCount) return { duplicate: true };

      // 4. only a PENDING or UNKNOWN verification can be resolved
      if (!["PENDING", "UNKNOWN"].includes(v.status)) return { ignored: true };

      const kyc = outcomeToKyc[outcome];
      await db.query(
        "UPDATE kyc_verifications SET status = $1, updated_at = now() WHERE id = $2",
        [kyc, v.id],
      );

      // 5. lock the merchant and move it only if it is still VERIFYING
      const m = (
        await db.query("SELECT * FROM merchants WHERE id = $1 FOR UPDATE", [
          v.merchant_id,
        ])
      ).rows[0];

      if (m.status === "VERIFYING") {
        await applyKycResult(db, v.merchant_id, kyc, v.requested_by);
      } else if (m.status === "REVIEW_REQUIRED") {
        // a timeout already sent it to review: just update the kyc status
        await db.query(
          "UPDATE merchants SET kyc_status = $1, updated_at = now() WHERE id = $2",
          [kyc, v.merchant_id],
        );
      }
      // if APPROVED or REJECTED, leave the merchant alone

      return { applied: true };
    });

    if (result.unknown) {
      return res.status(404).json({ error: "Unknown provider reference" });
    }
    // duplicates and ignored events still get 200, so the provider stops retrying
    res.json({ received: true, ...result });
  } catch (err) {
    next(err);
  }
});