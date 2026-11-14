import request from "supertest";
import { app } from "../src/app";
import { pool } from "../src/db/pool";
import {
  resetDb,
  seedUsers,
  login,
  auth,
  createMerchant,
  signedCallback,
  closePool,
} from "./helpers";

let merchant1: string,
  merchant2: string,
  maker: string,
  checker: string,
  admin: string;

beforeAll(async () => {
  await resetDb();
  await seedUsers();
  merchant1 = await login("merchant1@test.dev");
  merchant2 = await login("merchant2@test.dev");
  maker = await login("maker1@test.dev");
  checker = await login("checker1@test.dev");
  admin = await login("admin1@test.dev");
});

afterAll(closePool);

// moves a merchant straight to REVIEW_REQUIRED with a chosen kyc status
async function forceReview(id: number, kyc: string) {
  await pool.query(
    "UPDATE merchants SET status='REVIEW_REQUIRED', kyc_status=$1 WHERE id=$2",
    [kyc, id],
  );
}

describe("cross-merchant access", () => {
  it("blocks a merchant from reading another merchant's application", async () => {
    const created = await createMerchant(merchant1, 1);
    expect(created.status).toBe(201);

    const other = await request(app)
      .get(`/api/merchants/${created.body.id}`)
      .set(auth(merchant2));
    expect(other.status).toBe(404);

    const owner = await request(app)
      .get(`/api/merchants/${created.body.id}`)
      .set(auth(merchant1));
    expect(owner.status).toBe(200);
  });
});

describe("maker/checker separation", () => {
  it("blocks the person who submitted from reviewing", async () => {
    const created = await createMerchant(merchant1, 2);
    const id = created.body.id;

    // the admin submits, so the admin is now "touched" and cannot review
    await request(app)
      .post(`/api/merchants/${id}/submit`)
      .set(auth(admin))
      .expect(200);
    await forceReview(id, "VERIFIED");

    const self = await request(app)
      .post(`/api/merchants/${id}/review`)
      .set(auth(admin))
      .send({ action: "APPROVE" });
    expect(self.status).toBe(403);

    const other = await request(app)
      .post(`/api/merchants/${id}/review`)
      .set(auth(checker))
      .send({ action: "APPROVE" });
    expect(other.status).toBe(200);
    expect(other.body.status).toBe("APPROVED");
  });
});

describe("timeout handling", () => {
  it("never marks KYC verified on timeout and blocks approval", async () => {
    const created = await createMerchant(merchant1, 3);
    const id = created.body.id;
    await request(app)
      .post(`/api/merchants/${id}/submit`)
      .set(auth(merchant1))
      .expect(200);

    // identityRef ending in 3 simulates a provider timeout
    const verify = await request(app)
      .post("/api/kyc/verify")
      .set(auth(maker))
      .send({ merchantId: id, identityRef: "ID-1003" });
    expect(verify.status).toBe(201);
    expect(verify.body.status).toBe("UNKNOWN");
    expect(verify.body.providerRef).toBeTruthy(); // reference is saved

    const merchant = await request(app)
      .get(`/api/merchants/${id}`)
      .set(auth(checker));
    expect(merchant.body.kycStatus).toBe("UNKNOWN");

    const approve = await request(app)
      .post(`/api/merchants/${id}/review`)
      .set(auth(checker))
      .send({ action: "APPROVE" });
    expect(approve.status).toBe(409);
  });

  it("replays the same result for a repeated idempotency key", async () => {
    const created = await createMerchant(merchant1, 4);
    const id = created.body.id;
    await request(app)
      .post(`/api/merchants/${id}/submit`)
      .set(auth(merchant1))
      .expect(200);

    const send = () =>
      request(app)
        .post("/api/kyc/verify")
        .set(auth(maker))
        .set("Idempotency-Key", "k-4")
        .send({ merchantId: id, identityRef: "ID-1000" });

    const first = await send();
    const second = await send();
    expect(second.body.providerRef).toBe(first.body.providerRef);
    expect(second.body.idempotentReplay).toBe(true);
  });
});

describe("duplicate callbacks", () => {
  it("applies a callback once and ignores the repeat", async () => {
    const created = await createMerchant(merchant1, 5);
    const id = created.body.id;
    await request(app)
      .post(`/api/merchants/${id}/submit`)
      .set(auth(merchant1))
      .expect(200);

    // identityRef ending in 2 gives PENDING
    const verify = await request(app)
      .post("/api/kyc/verify")
      .set(auth(maker))
      .send({ merchantId: id, identityRef: "ID-1002" });
    expect(verify.body.status).toBe("PENDING");

    const payload = {
      eventId: "evt-5",
      providerRef: verify.body.providerRef,
      outcome: "SUCCESS",
    };
    const first = await signedCallback(payload);
    const second = await signedCallback(payload);
    expect(first.body.applied).toBe(true);
    expect(second.body.duplicate).toBe(true);

    const merchant = await request(app)
      .get(`/api/merchants/${id}`)
      .set(auth(checker));
    expect(merchant.body.kycStatus).toBe("VERIFIED");
    expect(merchant.body.status).toBe("REVIEW_REQUIRED");

    const count = await pool.query(
      "SELECT count(*)::int AS n FROM kyc_callbacks WHERE event_id = $1",
      ["evt-5"],
    );
    expect(count.rows[0].n).toBe(1);
  });

  it("rejects a callback with a bad signature", async () => {
    const res = await request(app)
      .post("/api/kyc/callback")
      .set("Content-Type", "application/json")
      .set("X-Signature", "deadbeef")
      .send({ eventId: "evt-x", providerRef: "PRV-none", outcome: "SUCCESS" });
    expect(res.status).toBe(401);
  });
});

describe("invalid status transitions", () => {
  it("blocks submitting twice and reviewing a DRAFT", async () => {
    const created = await createMerchant(merchant1, 6);
    const id = created.body.id;

    const early = await request(app)
      .post(`/api/merchants/${id}/review`)
      .set(auth(checker))
      .send({ action: "APPROVE" });
    expect(early.status).toBe(409);

    await request(app)
      .post(`/api/merchants/${id}/submit`)
      .set(auth(merchant1))
      .expect(200);
    const again = await request(app)
      .post(`/api/merchants/${id}/submit`)
      .set(auth(merchant1));
    expect(again.status).toBe(409);
  });

  it("blocks reviewing an already approved application", async () => {
    const created = await createMerchant(merchant1, 7);
    const id = created.body.id;
    await request(app)
      .post(`/api/merchants/${id}/submit`)
      .set(auth(merchant1))
      .expect(200);
    await forceReview(id, "VERIFIED");

    await request(app)
      .post(`/api/merchants/${id}/review`)
      .set(auth(checker))
      .send({ action: "APPROVE" })
      .expect(200);
    const again = await request(app)
      .post(`/api/merchants/${id}/review`)
      .set(auth(checker))
      .send({ action: "REJECT", reason: "too late" });
    expect(again.status).toBe(409);
  });
});

describe("sensitive data redaction", () => {
  it("never returns the full PAN or encrypted fields, and stores ciphertext", async () => {
    const created = await createMerchant(merchant1, 8);
    expect(created.status).toBe(201);

    const text = JSON.stringify(created.body);
    expect(text).not.toContain("ABCDE1008F");
    expect(created.body.pan).toBe("XXXXX1008X");
    expect(created.body.pan_encrypted).toBeUndefined();
    expect(created.body.pan_hash).toBeUndefined();

    const row = await pool.query(
      "SELECT pan_encrypted FROM merchants WHERE id = $1",
      [created.body.id],
    );
    expect(row.rows[0].pan_encrypted).not.toContain("ABCDE1008F");
  });

  it("redacts sensitive keys in log data", () => {
    const { redact } = require("../src/utils/mask");
    const out = redact({
      pan: "ABCDE1234F",
      password: "x",
      name: "Shop",
      nested: { token: "abc" },
    });
    expect(out.pan).toBe("[REDACTED]");
    expect(out.password).toBe("[REDACTED]");
    expect(out.nested.token).toBe("[REDACTED]");
    expect(out.name).toBe("Shop");
  });
});

describe("audit log", () => {
  it("records a CREATE event when an application is created", async () => {
    const created = await createMerchant(merchant1, 9);
    const rows = await pool.query(
      "SELECT action, from_status, to_status FROM audit_events WHERE merchant_id = $1",
      [created.body.id],
    );
    expect(rows.rows[0]).toEqual({
      action: "CREATE",
      from_status: null,
      to_status: "DRAFT",
    });
  });
});
