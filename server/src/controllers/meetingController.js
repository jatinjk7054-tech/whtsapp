import db from '../config/db.js';
import { emitDbChange } from '../socket.js';

const FRO_ROLES = new Set(['fro', 'worker', 'team_lead']);

const normalizeTeams = (val) => {
  if (!Array.isArray(val)) return [];
  const seen = new Set();
  const out = [];
  for (const t of val) {
    const s = String(t ?? '').trim().toUpperCase();
    if (s && !seen.has(s)) { seen.add(s); out.push(s); }
  }
  return out;
};

const getCallerTeam = async (userId) => {
  try {
    const { data } = await db
      .from('workers')
      .select('team')
      .eq('id', userId)
      .maybeSingle();
    return data?.team ? String(data.team).trim().toUpperCase() : null;
  } catch { return null; }
};

// The server is the authority on time. Clients that tick an elapsed timer
// against their own device clock show a different number on every phone (a
// clock behind us clamps to a permanent 00:00:00, a clock ahead inflates it),
// so every payload carries `server_now` for the client to anchor against, plus
// an already-computed `elapsed_seconds` so the very first paint is correct.
const serialize = (meeting) => {
  const server_now = new Date().toISOString();
  if (!meeting) return { active: false, server_now };

  const startMs = new Date(meeting.started_at).getTime();
  return {
    active: true,
    id: meeting.id,
    title: meeting.title || 'Meeting',
    started_by: meeting.started_by,
    started_by_name: meeting.started_by_name || 'Admin',
    started_at: meeting.started_at,
    teams: meeting.teams || [],
    server_now,
    elapsed_seconds: Number.isNaN(startMs)
      ? null
      : Math.max(0, Math.floor((Date.now() - startMs) / 1000)),
  };
};

// Decide whether a team-scoped meeting covers this caller.
//
// A caller with NO team must not be filtered out. `workers.team` is nullable
// and 39 of 72 active workers have it NULL/empty, so the previous
// `if (!callerTeam || ...) return inactive` silently excluded more than half
// the field from EVERY team-scoped meeting: the admin ticked all five UFS
// teams, the meeting was created, and those FROs never received the start
// event (their MeetingGate stayed closed and their counters kept running
// through the meeting). There is no team to scope them out of, so an
// unassigned caller is treated as covered.
export function meetingCoversCaller(meetingTeams, callerTeam) {
  const teams = Array.isArray(meetingTeams) ? meetingTeams : [];
  if (teams.length === 0) return true;              // global meeting
  const team = callerTeam ? String(callerTeam).trim().toUpperCase() : '';
  if (!team) return true;                            // unassigned -> covered
  return teams.some((t) => String(t ?? '').trim().toUpperCase() === team);
}

export const getMeetingStatus = async (req, res) => {
  try {
    const { data, error } = await db
      .from('meetings')
      .select('*')
      .eq('is_active', true)
      .order('started_at', { ascending: false })
      .limit(1);
    if (error) throw error;
    const meeting = data?.[0] || null;

    // FRO / worker / team_lead: only return the meeting if it covers their team.
    // An empty teams array means global (all teams).
    if (meeting && FRO_ROLES.has(String(req.user?.role || '').trim().toLowerCase())) {
      if (!meetingCoversCaller(meeting.teams, await getCallerTeam(req.user.id))) {
        return res.json({ active: false });
      }
    }

    return res.json(serialize(meeting));
  } catch (error) {
    return res.status(500).json({ message: 'Failed to fetch meeting status', error: error.message });
  }
};

export const startMeeting = async (req, res) => {
  try {
    const title = typeof req.body?.title === 'string' && req.body.title.trim()
      ? req.body.title.trim().slice(0, 120) : 'Meeting';
    const teams = normalizeTeams(req.body?.teams);

    // End any currently active meeting.
    await db
      .from('meetings')
      .update({ is_active: false, ended_at: new Date().toISOString() })
      .eq('is_active', true);

    const { data, error } = await db
      .from('meetings')
      .insert({
        is_active: true,
        title,
        started_by: String(req.user.id ?? ''),
        started_by_name: req.user.name || 'Admin',
        started_at: new Date().toISOString(),
        teams: teams.length > 0 ? teams : null,
      })
      .select()
      .single();
    if (error) throw error;
    emitDbChange({ table: 'meetings', eventType: 'INSERT', new: data });
    return res.json(serialize(data));
  } catch (error) {
    return res.status(500).json({ message: 'Failed to start meeting', error: error.message });
  }
};

export const endMeeting = async (req, res) => {
  try {
    const { data, error } = await db
      .from('meetings')
      .update({ is_active: false, ended_at: new Date().toISOString() })
      .eq('is_active', true)
      .select()
      .single();
    if (error) throw error;
    if (data) emitDbChange({ table: 'meetings', eventType: 'UPDATE', new: data });
    return res.json(serialize(data || null));
  } catch (error) {
    return res.status(500).json({ message: 'Failed to end meeting', error: error.message });
  }
};
