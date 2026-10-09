-- Migration 108: Asset specifications for machine categories (Laptop / Desktop).
-- Adds user-defined hardware specs captured alongside Brand/Model:
--   storage     — Hard Drive / SSD Drive (e.g. 512GB NVMe SSD)
--   ram         — RAM (e.g. 16GB DDR4)
--   processor   — Processor (e.g. Intel i7-12700H)
--   motherboard — Motherboard (e.g. Dell 0T10XW)
ALTER TABLE assets ADD COLUMN IF NOT EXISTS storage text;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS ram text;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS processor text;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS motherboard text;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS owner_name text;
