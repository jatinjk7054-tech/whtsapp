-- Migration for NGO Admin Panel - Critical Database Changes
-- Run this in Supabase SQL Editor

-- 1. Add last_activity_at column to fro_live_status
ALTER TABLE fro_live_status 
ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ;

-- 2. Create index for idle query performance
CREATE INDEX IF NOT EXISTS idx_fro_live_last_activity 
ON fro_live_status(last_activity_at);

-- 3. Update existing rows to have a default last_activity_at
UPDATE fro_live_status 
SET last_activity_at = updated_at 
WHERE last_activity_at IS NULL;

-- 4. Verify the changes
SELECT column_name, data_type, is_nullable 
FROM information_schema.columns 
WHERE table_name = 'fro_live_status' 
AND column_name = 'last_activity_at';

-- 5. Check index was created
SELECT indexname, indexdef 
FROM pg_indexes 
WHERE tablename = 'fro_live_status' 
AND indexname = 'idx_fro_live_last_activity';