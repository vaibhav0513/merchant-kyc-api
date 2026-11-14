ALTER TABLE merchants ADD COLUMN submitted_by INT REFERENCES users(id);

CREATE TABLE audit_events (
  id          BIGSERIAL PRIMARY KEY,
  merchant_id INT NOT NULL REFERENCES merchants(id),
  actor_id    INT NOT NULL REFERENCES users(id),
  action      TEXT NOT NULL,
  from_status TEXT,
  to_status   TEXT,
  reason      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- append-only: the database itself refuses updates and deletes
CREATE FUNCTION block_audit_changes() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION block_audit_changes();