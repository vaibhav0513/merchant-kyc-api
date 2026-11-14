CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('MERCHANT', 'MAKER', 'CHECKER', 'ADMIN')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE merchants (
  id               SERIAL PRIMARY KEY,
  business_name    TEXT NOT NULL,
  business_type    TEXT NOT NULL,
  contact_email    TEXT NOT NULL,
  contact_phone    TEXT NOT NULL,
  pan_encrypted    TEXT NOT NULL,   -- AES-256-GCM ciphertext
  pan_hash         TEXT NOT NULL UNIQUE,  -- HMAC blind index, used for duplicate checks
  pan_last4        CHAR(4) NOT NULL,
  status           TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN
                     ('DRAFT','SUBMITTED','VERIFYING','REVIEW_REQUIRED','APPROVED','REJECTED')),
  kyc_status       TEXT NOT NULL DEFAULT 'NOT_STARTED',
  owner_id         INT NOT NULL REFERENCES users(id),
  created_by       INT NOT NULL REFERENCES users(id),
  last_modified_by INT NOT NULL REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);