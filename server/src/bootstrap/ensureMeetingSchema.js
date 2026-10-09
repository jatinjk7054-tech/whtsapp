import db from '../config/db.js';

// Meetings: a single active "meeting mode" record. NGO admins pick one or more
// FRO teams (UFS1-UFS4) the meeting applies to; an empty teams array means
// all teams. FRO live counters pause only for affected teams.
// Reruns safely on every boot via IF NOT EXISTS.
export async function ensureMeetingSchema() {
  try {
    await db._pool.query(`
      CREATE TABLE IF NOT EXISTS meetings (
        id serial PRIMARY KEY,
        is_active boolean NOT NULL DEFAULT false,
        title text,
        started_by text,
        started_by_name text,
        started_at timestamptz,
        ended_at timestamptz
      );
    `);
    await db._pool.query(`
      ALTER TABLE meetings ADD COLUMN IF NOT EXISTS teams text[];
    `);
    await db._pool.query(`
      CREATE INDEX IF NOT EXISTS idx_meetings_teams ON meetings USING GIN(teams);
    `);
  } catch (error) {
    throw error;
  }
}

export default ensureMeetingSchema;