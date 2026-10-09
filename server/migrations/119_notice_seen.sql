-- Notice read-tracking — ensures popup notices show exactly once per user.
-- Idempotent. Mirrors src/bootstrap/ensureNoticeSchema.js.
CREATE TABLE IF NOT EXISTS notice_seen (
  id BIGSERIAL PRIMARY KEY,
  notice_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (notice_id, user_id)
);