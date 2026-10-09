-- 120: Clean up duplicate incentive_slabs rows
-- Keeps only the first occurrence of each (min_amount, max_amount) pair

DELETE FROM incentive_slabs
WHERE id NOT IN (
  SELECT DISTINCT ON (min_amount, max_amount) id
  FROM incentive_slabs
  ORDER BY min_amount, max_amount, created_at ASC
);

-- Verify: should show exactly 6 rows
-- SELECT min_amount, max_amount, incentive_amount, COUNT(*) 
-- FROM incentive_slabs GROUP BY min_amount, max_amount, incentive_amount;
