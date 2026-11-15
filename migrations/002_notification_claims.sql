BEGIN;

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS claim_token uuid,
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS claimed_until timestamptz;

CREATE INDEX IF NOT EXISTS idx_notifications_pending_claims
ON notifications (next_attempt, id)
WHERE sent_at IS NULL AND attempts < 8;

COMMIT;