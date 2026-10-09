-- Notice read-tracking fix: notices.id may be UUID, so notice_id must be TEXT
-- (accepts both bigint and uuid ids). Also numeric "created_by" values (0/-1)
-- must never be written into the UUID notices.created_by column.
ALTER TABLE notice_seen ALTER COLUMN notice_id TYPE TEXT USING notice_id::text; 