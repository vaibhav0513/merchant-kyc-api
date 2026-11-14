CREATE TABLE kyc_verifications (
  id              BIGSERIAL PRIMARY KEY,
  merchant_id     INT NOT NULL REFERENCES merchants(id),
  provider_ref    TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL CHECK (status IN ('PENDING','VERIFIED','FAILED','UNKNOWN')),
  idempotency_key TEXT,
  requested_by    INT NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- same user + same key = same verification (idempotency)
CREATE UNIQUE INDEX kyc_idem_unique
  ON kyc_verifications (requested_by, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- only one open (PENDING/UNKNOWN) verification per merchant at a time
CREATE UNIQUE INDEX kyc_one_open_per_merchant
  ON kyc_verifications (merchant_id)
  WHERE status IN ('PENDING','UNKNOWN');