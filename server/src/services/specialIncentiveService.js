import db, { sql } from '../config/db.js';

// "NGO wise Incentive" (special day incentive) engine.
// Flow: Super Admin announces -> active incentive pops in all panels ->
// per-FRO window collections tracked live -> first past the post wins.

const fmtMoney = (n) => Number(n || 0).toLocaleString('en-IN');

// Sum per-FRO collections whose ACTUAL collection time falls inside the
// incentive window. Mirrors the app's live collection logic (COLLECTION_DATE_OR)
// but with timestamp precision: donation logs count on created_at OR
// transaction_datetime, "done" disposals on the same, and verified "lead_done"
// on verified_at. When the incentive is NGO-specific ($3 NOT NULL), collections
// are scoped to fro_assignments.ngo_id so cross-NGO money never leaks into a
// different NGO's race. NULL $3 = org-wide incentive (all NGOs).
const WINDOW_COLLECTION_SQL = `
  SELECT l.fro_worker_id AS worker_id, COALESCE(SUM(l.amount_collected), 0)::float8 AS amount
  FROM fro_donor_logs l
  INNER JOIN fro_assignments fa ON fa.id = l.assignment_id
  WHERE l.fro_worker_id IS NOT NULL
    AND l.amount_collected > 0
    AND ($3::uuid IS NULL OR fa.ngo_id = $3)
    AND (
      (l.action = 'donation' AND (l.transaction_datetime BETWEEN $1 AND $2))
      OR (l.action = 'donation' AND (l.created_at BETWEEN $1 AND $2))
      OR (l.action = 'disposition' AND l.disposition_detail = 'done' AND (l.transaction_datetime BETWEEN $1 AND $2))
      OR (l.action = 'disposition' AND l.disposition_detail = 'done' AND (l.created_at BETWEEN $1 AND $2))
      OR (l.action = 'disposition' AND l.disposition_detail = 'lead_done' AND l.accounts_status = 'verified' AND l.verified_at BETWEEN $1 AND $2)
    )
  GROUP BY l.fro_worker_id
`;

// Everyone who should see special-incentive popups: FROs, Accounts, HR, and
// the sir-level roles (Super Admin / Admin).
const RECIPIENT_SQL = `
  SELECT id FROM workers
  WHERE is_active = true
    AND (
      lower(coalesce(department, '')) IN ('fro', 'accounts', 'hr', 'admin', 'ngo admin')
      OR lower(coalesce(role, '')) IN ('super_admin', 'admin')
    )
`;

export const getActiveIncentives = async () => {
  const { data, error } = await db
    .from('special_incentives')
    .select('*, ngos(name)')
    .eq('status', 'active')
    .is('archived_at', null)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
};

export const getIncentiveById = async (id) => {
  const { data, error } = await db
    .from('special_incentives')
    .select('*, ngos(name)')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data;
};

export const getLeaderboard = async (incentiveId) => {
  const { data, error } = await db
    .from('special_incentive_progress')
    .select('*, workers(name)')
    .eq('special_incentive_id', incentiveId)
    .order('collected_amount', { ascending: false })
    .order('updated_at', { ascending: true });
  if (error) throw error;
  return data || [];
};

export const getProgressForWorker = async (incentiveId, workerId) => {
  const { data, error } = await db
    .from('special_incentive_progress')
    .select('*')
    .eq('special_incentive_id', incentiveId)
    .eq('worker_id', workerId)
    .maybeSingle();
  if (error) throw error;
  return data;
};

const sendNotificationLogs = async (rows) => {
  if (!rows || rows.length === 0) return;
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const { error } = await db.from('notification_log').insert(chunk);
    if (error) console.error('[special incentive] notification insert:', error.message);
  }
};

// Seed a ₹0 progress row for every participant FRO so the leaderboard lists all
// contenders from second one. NGO-scoped incentives seed only that NGO's FROs
// (via fro_station_assignments); org-wide incentives seed every active FRO.
export const seedProgressForActiveFros = async (incentiveId, ngoId = null) => {
  try {
    let fros = [];
    if (ngoId) {
      const { data: assignments } = await db
        .from('fro_station_assignments')
        .select('fro_worker_id')
        .eq('ngo_id', ngoId)
        .not('fro_worker_id', 'is', null);
      const ids = [...new Set((assignments || []).map((a) => a.fro_worker_id))];
      if (ids.length > 0) {
        const { data: workers } = await db
          .from('workers')
          .select('id')
          .in('id', ids)
          .eq('is_active', true);
        fros = workers || [];
      }
    } else {
      const { data: workers } = await db
        .from('workers')
        .select('id')
        .eq('department', 'FRO')
        .eq('is_active', true);
      fros = workers || [];
    }
    const rows = (fros || []).map((w) => ({
      special_incentive_id: incentiveId,
      worker_id: w.id,
      collected_amount: 0,
    }));
    if (rows.length === 0) return;
    await db
      .from('special_incentive_progress')
      .upsert(rows, { onConflict: 'special_incentive_id,worker_id' });
  } catch (e) {
    console.error('[special incentive] seed progress:', e.message);
  }
};

// When an incentive is NGO-scoped, FRO recipients are limited to that NGO's
// station FROs so only eligible FROs get the "LIVE" bell/desktop alert.
const recipientsForIncentive = async (ngoId) => {
  const all = await sql(RECIPIENT_SQL);
  if (!ngoId) return all || [];
  const { data: assignments } = await db
    .from('fro_station_assignments')
    .select('fro_worker_id')
    .eq('ngo_id', ngoId)
    .not('fro_worker_id', 'is', null);
  const eligibleFroIds = new Set((assignments || []).map((a) => a.fro_worker_id).filter(Boolean));
  return (all || []).filter((r) => {
    const isFro = String(r.department || '').toLowerCase() === 'fro';
    return !isFro || eligibleFroIds.has(r.id);
  });
};

// Broadcast a "LIVE" announcement to FRO + Accounts + HR + SA via
// notification_log (shows in bell + desktop notifications everywhere). NGO
// races notify only that NGO's FROs.
export const announceIncentive = async (incentive, type = 'special_incentive') => {
  try {
    const rows = await recipientsForIncentive(incentive.ngo_id || null);
    if (!rows || rows.length === 0) return;
    if (type === 'special_incentive') {
      const title = `🔥 ${incentive.title} LIVE!`;
      const ngoTag = incentive.ngo_name ? ` [${incentive.ngo_name}]` : '';
      const body = `${ngoTag} Collect ₹${fmtMoney(incentive.target_amount)} by ${new Date(incentive.end_at).toLocaleString('en-IN', { hour: '2-digit', minute: '2-digit' })} and win ₹${fmtMoney(incentive.incentive_amount)}!`;
      const t = title + ngoTag;
      await sendNotificationLogs(
        rows.map((r) => ({
          worker_id: r.id,
          type: 'special_incentive',
          title: t,
          body,
          reference_id: String(incentive.id),
        }))
      );
    }
  } catch (e) {
    console.error('[special incentive] announce:', e.message);
  }
};

export const celebrateWinner = async (incentiveId, workerId, winnerName) => {
  try {
    const rows = await sql(RECIPIENT_SQL);
    if (!rows || rows.length === 0) return;
    const { data: inc } = await db
      .from('special_incentives')
      .select('title, target_amount, incentive_amount')
      .eq('id', incentiveId)
      .maybeSingle();
    const title = `🏆 WINNER: ${winnerName || 'A FRO'}`;
    const body = `${inc?.title || 'NGO wise Incentive'} won! ${winnerName || 'Someone'} was the first to collect ₹${fmtMoney(inc?.target_amount)} → wins ₹${fmtMoney(inc?.incentive_amount)}! 🎉`;
    await sendNotificationLogs(
      rows.map((r) => ({
        worker_id: r.id,
        type: 'special_incentive_win',
        title,
        body,
        reference_id: String(incentiveId),
      }))
    );
  } catch (e) {
    console.error('[special incentive] celebrate:', e.message);
  }
};

const notifyWinnerCelebration = async (inc) => {
  try {
    const rows = await sql(RECIPIENT_SQL);
    if (!rows || rows.length === 0) return;
    const title = `${inc?.winner_name || 'A FRO'} WON 🏆`;
    const body = inc?.congrats_message || `${inc?.winner_name || 'Someone'} won ${inc?.title || 'the incentive'}! 🎉`;
    await sendNotificationLogs(
      rows.map((r) => ({
        worker_id: r.id,
        type: 'special_incentive_celebration',
        title,
        body,
        reference_id: String(inc?.id),
      }))
    );
  } catch (e) {
    console.error('[special incentive] celeb notify:', e.message);
  }
};

// Publish the winner photo celebration: persists the photo URL + (AI) congrats
// message, stamps celebrated_at, then notifies every panel. Atomic — only flips
// when not posted yet, so double-clicks can't double-post.
export const publishWinnerCelebration = async (incentiveId, { photoUrl, message }) => {
  const { data, error } = await db
    .from('special_incentives')
    .update({
      winner_photo_url: photoUrl || null,
      congrats_message: message ? String(message).trim() : null,
      celebrated_at: new Date().toISOString(),
    })
    .eq('id', incentiveId)
    .eq('status', 'won')
    .is('celebrated_at', null)
    .select();
  if (error) throw error;
  const inc = (data && data[0]) || null;
  if (!inc) return null;
  await notifyWinnerCelebration(inc);
  console.log(`[special incentive] ${inc.title} winner celebration posted for ${inc.winner_name || 'unknown'}`);
  return inc;
};

// Recompute the live progress for one incentive from fro_donor_logs, then try
// to lock the first-past-the-post winner. Idempotent & concurrency-safe.
export const refreshSpecialIncentive = async (incentiveId) => {
  const inc = await getIncentiveById(incentiveId);
  if (!inc) return null;
  if (inc.status === 'cancelled') return null;
  if (inc.status === 'active' && new Date(inc.end_at).getTime() < Date.now()) {
    await endWithoutWinner(inc.id);
    return null;
  }
  if (inc.status !== 'active') return null;

  await seedProgressForActiveFros(inc.id, inc.ngo_id);

  const target = Number(inc.target_amount) || 0;
  const rows = await sql(WINDOW_COLLECTION_SQL, [inc.start_at, inc.end_at, inc.ngo_id]);
  const nowIso = new Date().toISOString();

  // One batched read instead of a SELECT per worker (N+1 on every refresh).
  const { data: existingRows } = await db
    .from('special_incentive_progress')
    .select('id, worker_id, hit_target_at')
    .eq('special_incentive_id', inc.id);
  const existingByWorker = new Map((existingRows || []).map((p) => [String(p.worker_id), p]));

  for (const r of rows || []) {
    const raw = Number(r.amount) || 0;
    const amount = Math.min(raw, target);
    const hit = raw >= target ? nowIso : null;
    try {
      const existing = existingByWorker.get(String(r.worker_id));
      if (existing) {
        await db
          .from('special_incentive_progress')
          .update({ collected_amount: amount, hit_target_at: existing.hit_target_at || hit, updated_at: nowIso })
          .eq('id', existing.id);
      } else {
        await db
          .from('special_incentive_progress')
          .insert([{ special_incentive_id: inc.id, worker_id: r.worker_id, collected_amount: amount, hit_target_at: hit }]);
      }
    } catch (e) {
      console.error('[special incentive] progress upsert:', e.message);
    }
  }

  return claimWinnerIfReady(inc.id);
};

export const claimWinnerIfReady = async (incentiveId) => {
  const inc = await getIncentiveById(incentiveId);
  if (!inc || inc.status !== 'active') return null;

  const { data: progress } = await db
    .from('special_incentive_progress')
    .select('worker_id, hit_target_at')
    .eq('special_incentive_id', incentiveId)
    .not('hit_target_at', 'is', null)
    .order('hit_target_at', { ascending: true })
    .limit(1);
  const winner = progress && progress[0];
  if (!winner) return null;

  const { data: w } = await db.from('workers').select('name').eq('id', winner.worker_id).maybeSingle();
  const winnerName = w?.name || null;

  // Atomic: only one process can flip status 'active' -> 'won'.
  const { data: updated, error } = await db
    .from('special_incentives')
    .update({
      status: 'won',
      winner_worker_id: winner.worker_id,
      winner_name: winnerName,
      winner_claimed_at: winner.hit_target_at,
    })
    .eq('id', incentiveId)
    .eq('status', 'active')
    .select();
  if (error) throw error;
  if (!updated || updated.length === 0) return null;

  const { data: row } = await db.from('special_incentives').select('*').eq('id', incentiveId).maybeSingle();
  await celebrateWinner(incentiveId, winner.worker_id, winnerName);
  console.log(`[special incentive] ${row?.title} WON by ${winnerName} (${winner.worker_id})`);
  return winner.worker_id;
};

export const endWithoutWinner = async (incentiveId) => {
  // No one won: end it AND auto-archive so it leaves the live views at once.
  const { data, error } = await db
    .from('special_incentives')
    .update({ status: 'ended', archived_at: new Date().toISOString(), archived_by: null })
    .eq('id', incentiveId)
    .eq('status', 'active')
    .select();
  if (error) throw error;
  if (data && data.length > 0) {
    console.log(`[special incentive] ${incentiveId} ended without a winner (auto-archived)`);
  }
};

// Cheap existence check + refresh. Safe to call after any donor-log write.
// In-flight guard: refreshes are triggered both by the scheduler poll and by
// every donor-log write, so overlapping runs would stack window aggregations
// and per-worker upserts on the t3.micro.
let refreshRunning = false;
export const maybeRefreshSpecialIncentives = async () => {
  if (refreshRunning) return;
  refreshRunning = true;
  try {
    const active = await getActiveIncentives();
    if (active.length === 0) return;
    await Promise.all(
      active.map((i) => refreshSpecialIncentive(i.id).catch((e) => console.error('[special incentive] refresh:', e.message)))
    );
  } catch (e) {
    console.error('[special incentive] maybeRefresh:', e.message);
  } finally {
    refreshRunning = false;
  }
};

export const createSpecialIncentive = async (payload, userId) => {
  const row = {
    title: String(payload.title || '').trim(),
    message: String(payload.message || '').trim(),
    ngo_id: payload.ngo_id || null,
    target_amount: Number(payload.target_amount) || 0,
    incentive_amount: Number(payload.incentive_amount) || 0,
    start_at: payload.start_at,
    end_at: payload.end_at,
    status: 'active',
    created_by: userId || null,
  };
  const { data, error } = await db.from('special_incentives').insert([row]).select().single();
  if (error) throw error;
  await seedProgressForActiveFros(data.id, data.ngo_id);
  await refreshSpecialIncentive(data.id);
  await announceIncentive(data);
  return data;
};

export const cancelSpecialIncentive = async (incentiveId) => {
  const { data, error } = await db
    .from('special_incentives')
    .update({ status: 'cancelled' })
    .eq('id', incentiveId)
    .eq('status', 'active')
    .select();
  if (error) throw error;
  return (data && data[0]) || null;
};

// Permanently silence an incentive's popups everywhere. For a still-running one
// it is also cancelled (closed with no winner); for resolved ones it is simply
// flagged so /active stops shipping it as a winner/photo celebration. Idempotent.
export const archiveSpecialIncentive = async (incentiveId, userId) => {
  const inc = await getIncentiveById(incentiveId);
  if (!inc) return null;

  if (inc.archived_at) return inc;

  const updates = {
    archived_at: new Date().toISOString(),
    archived_by: userId || inc.archived_by || null,
  };
  if (inc.status === 'active') {
    updates.status = 'cancelled';
  }

  const { data, error } = await db
    .from('special_incentives')
    .update(updates)
    .eq('id', incentiveId)
    .select();
  if (error) throw error;
  return (data && data[0]) || null;
};

export const getHistory = async (limit = 60) => {
  const { data, error } = await db
    .from('special_incentives')
    .select('*, ngos(name)')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
};

// Won incentives that still need Accounts to verify/claim the prize.
export const listPendingClaims = async () => {
  const { data, error } = await db
    .from('special_incentives')
    .select('*, ngos(name)')
    .eq('status', 'won')
    .eq('claim_status', 'pending')
    .order('winner_claimed_at', { ascending: false });
  if (error) throw error;
  return data || [];
};

// Won incentives that have been verified (prize paid out) by Accounts.
export const listVerifiedClaims = async (limit = 60) => {
  const { data, error } = await db
    .from('special_incentives')
    .select('*, ngos(name)')
    .eq('status', 'won')
    .eq('claim_status', 'verified')
    .order('claimed_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
};

export const claimSpecialIncentive = async (incentiveId, { photoUrl, claimedBy, remarks }) => {
  const updates = {
    claim_status: 'verified',
    claim_photo_url: photoUrl || null,
    claimed_by: claimedBy || null,
    claim_remarks: remarks || null,
    claimed_at: new Date().toISOString(),
  };
  const { data, error } = await db
    .from('special_incentives')
    .update(updates)
    .eq('id', incentiveId)
    .eq('status', 'won')
    .eq('claim_status', 'pending')
    .select();
  if (error) throw error;
  return (data && data[0]) || null;
};

export const deleteSpecialIncentive = async (incentiveId) => {
  try {
    await db.from('special_incentive_progress').delete().eq('special_incentive_id', incentiveId);
  } catch (e) {
    console.error('[special incentive] progress delete:', e.message);
  }
  try {
    await db.from('notification_log').delete().eq('type', 'special_incentive').eq('reference_id', String(incentiveId));
  } catch (e) {
    console.error('[special incentive] notification delete:', e.message);
  }
  const { data, error } = await db
    .from('special_incentives')
    .delete()
    .eq('id', incentiveId)
    .select('id');
  if (error) throw error;
  return (data && data[0]) || null;
};

// Admin edits a live incentive's setup (title/message/target/reward/window/ngo).
// Only active (non-closed) incentives can be edited; winners and payouts stay untouched.
export const updateSpecialIncentive = async (incentiveId, fields) => {
  const allowed = ['title', 'message', 'target_amount', 'incentive_amount', 'start_at', 'end_at', 'ngo_id'];
  const patch = {};
  for (const k of allowed) {
    if (fields[k] !== undefined) patch[k] = fields[k];
  }
  if (Object.keys(patch).length === 0) return null;
  const { data, error } = await db
    .from('special_incentives')
    .update(patch)
    .eq('id', incentiveId)
    .eq('status', 'active')
    .select('*, ngos(name)')
    .maybeSingle();
  if (error) throw error;
  return data || null;
};
