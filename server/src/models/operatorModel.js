import db from '../config/db.js';

export const createOperatorEvent = async (data) => {
  const { data: result, error } = await db
    .from('operator_events')
    .insert({ ...data, updated_at: new Date() })
    .select('*')
    .single();
  if (error) throw error;
  return result;
};

export const updateOperatorEvent = async (id, updates) => {
  const { data, error } = await db
    .from('operator_events')
    .update({ ...updates, updated_at: new Date() })
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data;
};

export const getOperatorEventByTitleDate = async (title, date) => {
  if (!title) return null;
  let query = db
    .from('operator_events')
    .select('*')
    .eq('title', title);
  if (date) query = query.eq('event_date', date);
  const { data, error } = await query.maybeSingle();
  if (error && error.code !== 'PGRST116') throw error;
  return data || null;
};

export const getOperatorEventById = async (id) => {
  const { data, error } = await db
    .from('operator_events')
    .select('*')
    .eq('id', id)
    .single();
  if (error) return null;
  return data;
};

export const listOperatorEvents = async ({ date, state } = {}) => {
  let query = db
    .from('operator_events')
    .select('*')
    .order('event_date', { ascending: true })
    .order('start_time', { ascending: true });
  if (date) query = query.eq('event_date', date);
  if (state) query = query.ilike('state', `%${state}%`);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
};

export const deleteOperatorEvent = async (id) => {
  const { error } = await db.from('operator_events').delete().eq('id', id);
  if (error) throw error;
  return { message: 'Event deleted' };
};

export const assignOperatorEvent = async (data) => {
  const { data: result, error } = await db
    .from('operator_assignments')
    .upsert(data, { onConflict: 'operator_id,assignment_date,event_id' })
    .select('*')
    .single();
  if (error) throw error;
  return result;
};

export const getOperatorAssignmentsByDate = async (operatorId, date) => {
  const { data, error } = await db
    .from('operator_assignments')
    .select('*, operator_events(*)')
    .eq('operator_id', operatorId)
    .eq('assignment_date', date);
  if (error) throw error;
  return data || [];
};

export const getTodayAssignment = async (operatorId, date) => {
  const { data, error } = await db
    .from('operator_assignments')
    .select('*, operator_events(*)')
    .eq('operator_id', operatorId)
    .eq('assignment_date', date)
    .maybeSingle();
  if (error && error.code !== 'PGRST116') throw error;
  return data || null;
};

// Upsert the operator's own assignment for one day (no event required).
export const upsertSelfAssignment = async (operatorId, { state, city, event_id, assignment_date, selfie_url, kit_id, organizer_id }) => {
  const { data, error } = await db
    .from('operator_assignments')
    .upsert(
      {
        operator_id: operatorId,
        state: state || null,
        city: city || null,
        event_id: event_id || null,
        assignment_date,
        selfie_url: selfie_url || null,
        kit_id: kit_id || null,
        organizer_id: organizer_id || null,
      },
      { onConflict: 'operator_id,assignment_date,event_id' }
    )
    .select('*, operator_events(*)')
    .single();
  if (error) throw error;
  return data;
};

// Attach programs to an event (event_programs join). Idempotent upsert.
export const attachProgramsToEvent = async (eventId, programIds, addedBy) => {
  const ids = (Array.isArray(programIds) ? programIds : [])
    .map((pid) => parseInt(pid, 10))
    .filter((pid) => Number.isInteger(pid));
  if (ids.length === 0) return [];
  const rows = ids.map((program_id) => ({
    event_id: eventId,
    program_id,
    added_by: addedBy || 'system',
  }));
  const { data, error } = await db
    .from('event_programs')
    .upsert(rows, { onConflict: 'event_id,program_id' })
    .select('*');
  if (error) throw error;
  return data || [];
};

// Programs attached to an event.
export const listEventPrograms = async (eventId) => {
  const { data, error } = await db
    .from('event_programs')
    .select('*, bnf_programs(*)')
    .eq('event_id', eventId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data || []).map((r) => r.bnf_programs).filter(Boolean);
};

export const removeEventProgram = async (eventId, programId) => {
  const { error } = await db
    .from('event_programs')
    .delete()
    .eq('event_id', eventId)
    .eq('program_id', programId);
  if (error) throw error;
  return { message: 'Program removed from event' };
};

// Beneficiaries whose kit was marked under this event (KIT_GIVEN audit rows
// carrying details.event_id). Returns the beneficiary + mark metadata.
export const listEventMarkedBeneficiaries = async (eventId) => {
  const { data, error } = await db
    .from('beneficiary_audit_logs')
    .select(
      'id, beneficiary_id, performed_by, performed_at, details, beneficiaries(id, beneficiary_code, full_name, mobile, photo)'
    )
    .eq('action', 'KIT_GIVEN')
    .eq('details->>event_id', String(eventId))
    .order('performed_at', { ascending: false })
    .limit(500);
  if (error) throw error;
  return (data || []).map((r) => ({
    audit_id: r.id,
    beneficiary_id: r.beneficiary_id,
    beneficiary_code: r.beneficiaries?.beneficiary_code || null,
    full_name: r.beneficiaries?.full_name || null,
    mobile: r.beneficiaries?.mobile || null,
    photo: r.beneficiaries?.photo || null,
    performed_by: r.performed_by,
    performed_at: r.performed_at,
    details: r.details,
  }));
};

// Per-NGO (BSCT/AFLF/MANN) registration and kit-given counts, today's event
// name, and the most recent kit handouts. Drives the Beneficiaries app's Kits
// screen.
export const getKitsDashboard = async ({ operatorId, date } = {}) => {
  // db._pool is raw node-postgres: results come back on `rows`, not `data`.
  // Reading `data` here left ngoRows undefined, so every NGO fell through to
  // the zero fallback and the Kits screen showed 0 regardless of real data.
  const { rows: ngoRows } = await db._pool
    .query(
      `SELECT n.id, n.name,
              COUNT(b.id) FILTER (WHERE b.ngo_id = n.id)                                        AS registered,
              COUNT(b.id) FILTER (WHERE b.ngo_id = n.id AND b.kit_given = true)                 AS kit_given
         FROM ngos n
         LEFT JOIN beneficiaries b ON b.ngo_id = n.id
        WHERE UPPER(n.name) IN ('BSCT', 'AFLF', 'MANN')
        GROUP BY n.id, n.name
        ORDER BY n.name`
    )
    .catch((e) => {
      console.error('getKitsDashboard NGO count query failed:', e);
      return { rows: [] };
    });

  const byName = {};
  for (const r of ngoRows || []) {
    const key = String(r.name || '').toUpperCase();
    byName[key] = {
      name: String(r.name || ''),
      registered: Number(r.registered) || 0,
      kit_given: Number(r.kit_given) || 0,
    };
  }
  const programs = ['BSCT', 'AFLF', 'MANN'].map((code) => ({
    code,
    ...(byName[code] || { name: code, registered: 0, kit_given: 0 }),
  }));

  const total_registered = programs.reduce((s, p) => s + p.registered, 0);

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const { count: kitGivenToday } = await db
    .from('beneficiaries')
    .select('id', { count: 'exact', head: true })
    .eq('kit_given', true)
    .gte('kit_given_at', todayStart.toISOString());

  // Today's event: the operator's assignment first, then any event scheduled
  // for today, then the demo fallback (mirrors markBeneficiaryKitGiven).
  let event_name = null;
  let event_id = null;
  try {
    if (operatorId) {
      const assignment = await getTodayAssignment(operatorId, date);
      const ev = assignment?.operator_events;
      if (ev) {
        event_name = ev?.title || ev?.name || null;
        event_id = ev?.id != null ? Number(ev.id) : null;
      }
    }
    if (!event_name) {
      const events = await listOperatorEvents({ date });
      if (events && events.length > 0) {
        event_name = events[0].title || events[0].name || demoOperatorEvent.title;
        event_id = events[0].id != null ? Number(events[0].id) : null;
      } else {
        event_name = demoOperatorEvent.title;
      }
    }
  } catch (_) {
    if (!event_name) event_name = demoOperatorEvent.title;
  }

  // Most recent kit handouts with beneficiary identity + the event it was
  // collected at. Today-scoped to match the kit-given counter above.
  const { data: logs, error } = await db
    .from('beneficiary_audit_logs')
    .select(
      'beneficiary_id, performed_by, performed_at, details, beneficiaries(id, beneficiary_code, full_name, mobile, photo)'
    )
    .eq('action', 'KIT_GIVEN')
    .gte('performed_at', todayStart.toISOString())
    .order('performed_at', { ascending: false })
    .limit(200);
  if (error) throw error;

  const collectors = (logs || []).map((r) => ({
    beneficiary_id: r.beneficiary_id,
    beneficiary_code: r.beneficiaries?.beneficiary_code || null,
    full_name: r.beneficiaries?.full_name || null,
    mobile: r.beneficiaries?.mobile || null,
    photo: r.beneficiaries?.photo || null,
    event_name: r.details?.event_name || null,
    event_id: r.details?.event_id != null ? Number(r.details.event_id) : null,
    performed_by: r.performed_by,
    performed_at: r.performed_at,
  }));

  return {
    programs,
    total_registered,
    kit_given_today: kitGivenToday || 0,
    event_name,
    event_id,
    collectors,
  };
};

// Demo event used when no real event exists yet (for testing the dropdown).
export const demoOperatorEvent = {
  id: null,
  title: 'Demo Event',
  description: 'Sample event for testing',
  event_date: new Date().toISOString().split('T')[0],
  start_time: '10:00',
  end_time: '17:00',
  location: 'Test Venue',
  state: null,
  city: null,
  selfie_url: null,
};