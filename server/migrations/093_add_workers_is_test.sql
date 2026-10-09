-- Migration 093: Add is_test flag for test member accounts.
-- Test members stay visible/selectable everywhere (agent pickers, salary);
-- only dashboard stats (total workers, NGO split, dept/gender, attendance
-- percentage, birthdays/anniversaries) exclude them.
ALTER TABLE workers ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;
        