import db from '../config/db.js';

// Storage for the hand-typed half of HR > Reports.
//
// Everything countable (present, half-day, testing members, interviewer tallies)
// is derived live in hrDailyReportController.js and never written here. This
// table holds only what has no source in the database: the WO-PI / WPI absence
// lists, terminations, and per-recruiter free text.
//
// One row per (report_date, reporter_name) — a reporter owns their own day.

const COLUMNS = [
  'id', 'report_date', 'reporter_name', 'absent_wopi', 'absent_wpi',
  'terminations', 'mis_manual', 'created_by', 'created_at', 'updated_at',
];

export const getReport = async (report_date, reporter_name) => {
  const { data, error } = await db
    .from('hr_daily_reports')
    .select(COLUMNS.join(', '))
    .eq('report_date', report_date)
    .eq('reporter_name', reporter_name)
    .maybeSingle();
  if (error) throw error;
  return data || null;
};

export const listReportsForDate = async (report_date) => {
  const { data, error } = await db
    .from('hr_daily_reports')
    .select(COLUMNS.join(', '))
    .eq('report_date', report_date)
    .order('reporter_name', { ascending: true });
  if (error) throw error;
  return data || [];
};

// Update first, insert only if nothing matched, rather than
// db.from().upsert(). Two reasons, both of which the builder's ON CONFLICT
// DO UPDATE gets wrong for this table:
//
//   1. created_by must be first-write-only. _execUpsert in config/db.js emits
//      `col = EXCLUDED.col` for *every* non-conflict column it was handed, so an
//      upsert that includes created_by silently restamps it with whoever typed
//      last. Two accounts sharing a name collide on
//      (report_date, reporter_name) and would overwrite each other's author.
//      An UPDATE payload that simply never mentions created_by makes the rule
//      structural instead of a comment.
//
//   2. Timestamps stay on the database clock. The old version sent
//      `updated_at: new Date().toISOString()`, which on insert beat the
//      created_at DEFAULT (NOW()) and left updated_at about a second *before*
//      created_at. Not sending it lets both default on insert, and the
//      hr_daily_reports_touch BEFORE UPDATE trigger stamps every update.
export const upsertReport = async ({ report_date, reporter_name, absent_wopi, absent_wpi, terminations, mis_manual, created_by }) => {
  // Stored as '' rather than NULL so the UI always gets a string back and can
  // render it in a controlled input without a null guard.
  const edits = {
    absent_wopi: absent_wopi || '',
    absent_wpi: absent_wpi || '',
    terminations: terminations || '',
    mis_manual: mis_manual && typeof mis_manual === 'object' ? mis_manual : {},
  };

  const { data: updated, error: updateError } = await db
    .from('hr_daily_reports')
    .update(edits)
    .eq('report_date', report_date)
    .eq('reporter_name', reporter_name)
    .select(COLUMNS.join(', '));
  if (updateError) throw updateError;
  if (updated && updated.length) return updated[0];

  // No row yet: this is the first save, so this is the only time created_by is
  // ever written.
  const { data: inserted, error: insertError } = await db
    .from('hr_daily_reports')
    .insert({ ...edits, report_date, reporter_name, created_by: created_by || null })
    .select(COLUMNS.join(', '))
    .single();

  // A double submit (or a retry after a flaky connection) can slip two inserts
  // past the update above and land on the unique constraint together. That is
  // the row now existing, so fall back to updating it instead of failing the
  // save the reporter is waiting on.
  if (insertError) {
    const raced = await db
      .from('hr_daily_reports')
      .update(edits)
      .eq('report_date', report_date)
      .eq('reporter_name', reporter_name)
      .select(COLUMNS.join(', '));
    if (raced.error) throw insertError;
    if (raced.data && raced.data.length) return raced.data[0];
    throw insertError;
  }
  return inserted || null;
};
