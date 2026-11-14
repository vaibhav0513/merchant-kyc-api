CREATE TABLE kyc_callbacks (
  event_id     TEXT PRIMARY KEY,   -- provider's unique event id; the primary key blocks duplicates
  provider_ref TEXT NOT NULL,
  outcome      TEXT NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);