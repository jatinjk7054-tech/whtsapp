import db from '../config/db.js';
import groq, { GROQ_CHAT_MODEL } from '../config/groq.js';
import {
  getActiveIncentives,
  getIncentiveById,
  getLeaderboard,
  getProgressForWorker,
  createSpecialIncentive,
  updateSpecialIncentive,
  cancelSpecialIncentive,
  getHistory,
  refreshSpecialIncentive,
  listPendingClaims,
  listVerifiedClaims,
  claimSpecialIncentive,
  publishWinnerCelebration,
  archiveSpecialIncentive,
  deleteSpecialIncentive,
} from '../services/specialIncentiveService.js';

const pretty = (inc) => (inc ? {
  id: inc.id,
  title: inc.title,
  message: inc.message,
  ngo_id: inc.ngo_id || null,
  ngo_name: inc.ngos?.name || null,
  target_amount: Number(inc.target_amount) || 0,
  incentive_amount: Number(inc.incentive_amount) || 0,
  start_at: inc.start_at,
  end_at: inc.end_at,
  status: inc.status,
  winner_worker_id: inc.winner_worker_id,
  winner_name: inc.winner_name,
  winner_claimed_at: inc.winner_claimed_at,
  claim_status: inc.claim_status || 'pending',
  claim_photo_url: inc.claim_photo_url || null,
  claimed_by: inc.claimed_by || null,
  claimed_at: inc.claimed_at || null,
  claim_remarks: inc.claim_remarks || null,
  winner_photo_url: inc.winner_photo_url || null,
  congrats_message: inc.congrats_message || null,
  celebrated_at: inc.celebrated_at || null,
  archived_at: inc.archived_at || null,
  archived_by: inc.archived_by || null,
  created_at: inc.created_at,
} : null);

// Keep Groq calls at least ~1.5s apart (shared quota across the app).
const throttleGroq = async () => {
  const wait = 1500 - (Date.now() - (global.__groqLastCall || 0));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
};

// Was the first caller to be fixed when llama-3.3-70b-versatile was removed
// from the Groq account (-> 404 model_not_found). The model now lives in
// config/groq.js so all five call sites share one definition.
const CONGRATS_MODEL = GROQ_CHAT_MODEL;

export async function generateCongratsMessage({ winnerName, title, amount }) {
  await throttleGroq();
  global.__groqLastCall = Date.now();
  const completion = await groq.chat.completions.create({
    messages: [
      {
        role: 'system',
        content:
          'You write SUPER ENERGETIC, hype-filled congratulations (2-3 sentences) for FRO fundraising officers who won a collection incentive at a donation NGO. Mention the winner by name, the incentive and the prize. Loud, proud, electrifying — like a stadium celebration. Use at most one emoji. Plain text only, no quotes, no markdown.',
      },
      { role: 'user', content: `Winner: ${winnerName || 'The winner'}\nIncentive: ${title || 'the NGO wise incentive'}\nPrize: ₹${Number(amount) || 0}` },
    ],
    model: CONGRATS_MODEL,
    max_tokens: 160,
    temperature: 0.85,
  });
  return (completion.choices?.[0]?.message?.content || '').trim();
}

export async function createHandler(req, res) {
  try {
    const { title, target_amount, incentive_amount, start_at, end_at, ngo_id } = req.body || {};
    if (!title || !String(title).trim()) {
      return res.status(400).json({ message: 'Title is required' });
    }
    if (!(Number(target_amount) > 0) || !(Number(incentive_amount) > 0)) {
      return res.status(400).json({ message: 'Target and incentive amount must be greater than zero' });
    }
    if (!start_at || !end_at || new Date(start_at).getTime() >= new Date(end_at).getTime()) {
      return res.status(400).json({ message: 'End date-time must be after start date-time' });
    }
    const payload = { ...req.body };
    if (ngo_id) payload.ngo_id = ngo_id;
    const incentive = await createSpecialIncentive(payload, req.user?.id);
    return res.status(201).json({ incentive: pretty(incentive) });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
}

// NGO ids the caller is attached to (via fro_station_assignments). Super Admins
// and Admins are org-wide and see every incentive; anyone with no station
// assignment (HR, Accounts, etc.) observes org-wide incentives only.
const ngoIdsForUser = async (user) => {
  if (!user?.id) return [];
  if (['super_admin', 'admin'].includes(user.role)) return null;
  const { data } = await db
    .from('fro_station_assignments')
    .select('ngo_id')
    .eq('fro_worker_id', user.id)
    .not('ngo_id', 'is', null);
  const ids = [...new Set((data || []).map((a) => a.ngo_id))];
  return ids.length > 0 ? ids : null;
};

// Live popup payload: the NGO-scoped, currently-running incentives with their
// leaderboard, the caller's own progress, plus recently closed incentives so
// per-NGO winner cards show even while other NGOs' races are still live.
export async function activeHandler(req, res) {
  try {
    const now = Date.now();
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const dayStartIso = dayStart.toISOString();
    const { data: lastClosed } = await db
      .from('special_incentives')
      .select('*, ngos(name)')
      .not('status', 'eq', 'active')
      .is('archived_at', null)
      .gte('created_at', dayStartIso)
      .order('created_at', { ascending: false })
      .limit(5);
    const recentClosedAll = (lastClosed || []).map(pretty);

    let incentives = await getActiveIncentives();

    const myNgoIds = await ngoIdsForUser(req.user);
    // Winner announcements are org-wide: every FRO sees today's winners/flash.
    const recentClosed = recentClosedAll;
    if (myNgoIds) {
      incentives = incentives.filter((i) => !i.ngo_id || myNgoIds.includes(i.ngo_id));
    }
    incentives = incentives.filter((i) => new Date(i.start_at).getTime() <= now);

    const result = [];
    const boardByIncentive = new Map();
    for (const inc of incentives) {
      const board = await getLeaderboard(inc.id);
      boardByIncentive.set(inc.id, board || []);
    }
    // Profile photos for every leaderboard row (single query, shown as avatars).
    let boardPhotoMap = {};
    try {
      const boardWorkerIds = [...new Set(
        [...boardByIncentive.values()].flat().map((p) => p.worker_id).filter(Boolean)
      )];
      if (boardWorkerIds.length > 0) {
        const { data: boardWorkers } = await db.from('workers').select('id, photo_url').in('id', boardWorkerIds);
        boardPhotoMap = Object.fromEntries((boardWorkers || []).map((w) => [w.id, w.photo_url || null]));
      }
    } catch (e) {
      console.error('[special incentive] leaderboard photos:', e.message);
    }
    for (const inc of incentives) {
      const board = boardByIncentive.get(inc.id) || [];
      const base = pretty(inc);
      const mine = req.user?.id ? await getProgressForWorker(inc.id, req.user.id) : null;
      result.push({
        ...base,
        leaderboard: board.map((p) => ({
          worker_id: p.worker_id,
          name: p.workers?.name || 'Unknown',
          photo_url: boardPhotoMap[p.worker_id] || null,
          collected_amount: Number(p.collected_amount) || 0,
          hit_target_at: p.hit_target_at,
        })),
        mine: mine ? { worker_id: mine.worker_id, collected_amount: Number(mine.collected_amount) || 0 } : null,
      });
    }

    // Winner photo celebration: most recent won incentive whose photo was
    // posted by Sir within the last 48h, so every panel pops it up.
    let celeb = null;
    try {
      const { data: lastCeleb } = await db
        .from('special_incentives')
        .select('*, ngos(name)')
        .eq('status', 'won')
        .is('archived_at', null)
        .not('celebrated_at', 'is', null)
        .gte('celebrated_at', dayStartIso)
        .order('celebrated_at', { ascending: false })
        .limit(1);
      celeb = lastCeleb && lastCeleb[0] ? pretty(lastCeleb[0]) : null;
    } catch (e) {
      console.error('[special incentive] celeb payload:', e.message);
    }

    // Attach each winner's own profile photo (workers.photo_url) so the FRO
    // panel winner card can show the winner's face for ~5 seconds.
    const winnerIds = [...new Set(
      [...recentClosed.map((i) => i.winner_worker_id), ...(celeb?.winner_worker_id ? [celeb.winner_worker_id] : [])].filter(Boolean)
    )];
    let avatarMap = {};
    if (winnerIds.length > 0) {
      try {
        const { data: winners } = await db.from('workers').select('id, photo_url').in('id', winnerIds);
        avatarMap = Object.fromEntries((winners || []).map((w) => [w.id, w.photo_url || null]));
      } catch (e) {
        console.error('[special incentive] winner avatar:', e.message);
      }
    }
    const finalRecent = recentClosed.map((i) => ({ ...i, winner_avatar: avatarMap[i.winner_worker_id] || null }));
    if (celeb) celeb = { ...celeb, winner_avatar: avatarMap[celeb.winner_worker_id] || null };

    return res.json({ incentives: result, recent: finalRecent, celeb });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
}

export async function historyHandler(req, res) {
  try {
    const list = await getHistory(Number(req.query.limit) || 60);
    const enriched = [];
    const ids = new Set();
    for (const inc of list) {
      const base = pretty(inc);
      const board = await getLeaderboard(inc.id);
      for (const p of board || []) if (p.worker_id) ids.add(p.worker_id);
      enriched.push({ ...base, leaderboard: board });
    }
    // Attach profile photos so leaderboard cards can show faces.
    let photoMap = {};
    if (ids.size > 0) {
      try {
        const { data: ws } = await db.from('workers').select('id, photo_url').in('id', [...ids]);
        photoMap = Object.fromEntries((ws || []).map((w) => [w.id, w.photo_url || null]));
      } catch (e) {
        console.error('[special incentive] leaderboard photos:', e.message);
      }
    }
    return res.json(enriched.map((e) => ({
      ...e,
      leaderboard: (e.leaderboard || []).map((p) => ({ ...p, photo_url: photoMap[p.worker_id] || null })),
    })));
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
}

export async function updateHandler(req, res) {
  try {
    const inc = await getIncentiveById(req.params.id);
    if (!inc) return res.status(404).json({ message: 'Incentive not found' });
    if (inc.status !== 'active') {
      return res.status(400).json({ message: 'Only live incentives can be edited' });
    }
    const { title, message, target_amount, incentive_amount, start_at, end_at, ngo_id } = req.body || {};
    if (title !== undefined && !String(title).trim()) {
      return res.status(400).json({ message: 'Title is required' });
    }
    if (target_amount !== undefined && !(Number(target_amount) > 0)) {
      return res.status(400).json({ message: 'Target must be more than zero' });
    }
    if (incentive_amount !== undefined && !(Number(incentive_amount) > 0)) {
      return res.status(400).json({ message: 'Reward must be more than zero' });
    }
    if ((start_at !== undefined || end_at !== undefined)) {
      const s = start_at !== undefined ? start_at : inc.start_at;
      const e = end_at !== undefined ? end_at : inc.end_at;
      if (!s || !e || new Date(s).getTime() >= new Date(e).getTime()) {
        return res.status(400).json({ message: 'End date-time must be after start date-time' });
      }
    }
    const updated = await updateSpecialIncentive(req.params.id, {
      ...(title !== undefined ? { title: String(title).trim() } : {}),
      ...(message !== undefined ? { message: String(message || '') } : {}),
      ...(target_amount !== undefined ? { target_amount: Number(target_amount) } : {}),
      ...(incentive_amount !== undefined ? { incentive_amount: Number(incentive_amount) } : {}),
      ...(start_at !== undefined ? { start_at: new Date(start_at).toISOString() } : {}),
      ...(end_at !== undefined ? { end_at: new Date(end_at).toISOString() } : {}),
      ...(ngo_id !== undefined ? { ngo_id: ngo_id || null } : {}),
    });
    if (!updated) return res.status(400).json({ message: 'Unable to update this incentive' });
    return res.json({ incentive: pretty(updated) });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
}

// AI-drafted title + message for a NEW incentive, looking at the target and
// reward. Falls back to a template so the button never hard-fails.
export async function aiDraftHandler(req, res) {
  try {
    const target = Number(req.body?.target_amount) || 0;
    const reward = Number(req.body?.incentive_amount) || 0;
    const ngoName = String(req.body?.ngo_name || 'All NGOs');
    const fallback = () => ({
      title: `${ngoName} Mega Collection Blast!`,
      message: `BOOM! First FRO to smash ₹${target.toLocaleString('en-IN')} grabs a massive ₹${reward.toLocaleString('en-IN')}! Full speed, full energy — GO GO GO! 🔥`,
    });
    try {
      const model = GROQ_CHAT_MODEL;
      const completion = await groq.chat.completions.create({
        messages: [
          {
            role: 'system',
            content:
              'You write SUPER ENERGETIC, hype-filled incentive announcements for FRO fundraising officers at a donation NGO. High voltage,exciting, urgent, chest-thumping motivation — like a sports coach firing up the team. Reply in EXACTLY two lines: line 1 is the incentive title (max 8 words, punchy, plain text, no quotes), line 2 is the announcement message (1-2 sentences bursting with energy, mention the target and reward amounts with ₹, at most one emoji). Plain text only, no markdown, no numbering.',
          },
          { role: 'user', content: `NGO: ${ngoName}\nTarget: ₹${target}\nReward: ₹${reward}` },
        ],
        model,
        max_tokens: 200,
        temperature: 0.9,
      });
      const text = (completion.choices?.[0]?.message?.content || '').trim();
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.length >= 2) {
        return res.json({ title: lines[0].replace(/^["“”']+|["“”']+$/g, ''), message: lines.slice(1).join(' ') });
      }
      if (lines.length === 1) {
        const fb = fallback();
        return res.json({ title: lines[0], message: fb.message });
      }
    } catch (e) {
      console.error('[special incentive] ai draft:', e.message);
    }
    return res.json(fallback());
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
}

// AI-written congratulation preview for a won incentive (History composer).
// Falls back to a template so the button never hard-fails.
export async function congratsHandler(req, res) {
  try {
    const inc = await getIncentiveById(req.params.id);
    if (!inc) return res.status(404).json({ message: 'Incentive not found' });
    try {
      const text = await generateCongratsMessage({
        winnerName: inc.winner_name,
        title: inc.title,
        amount: inc.incentive_amount,
      });
      if (text) return res.json({ message: text });
    } catch (e) {
      console.error('[special incentive] ai congrats:', e.message);
    }
    return res.json({
      message: `Heartiest congratulations to ${inc.winner_name || 'our champion'} for winning "${inc.title || 'the incentive'}" with a reward of ₹${Number(inc.incentive_amount || 0).toLocaleString('en-IN')}! Your hard work inspires the whole team. 🎉`,
    });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
}

export async function cancelHandler(req, res) {
  try {
    const cancelled = await cancelSpecialIncentive(req.params.id);
    if (!cancelled) {
      return res.status(400).json({ message: 'Incentive not active or already closed' });
    }
    return res.json({ incentive: pretty(cancelled) });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
}

export async function refreshHandler(req, res) {
  try {
    await refreshSpecialIncentive(req.params.id);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
}

export async function detailHandler(req, res) {
  try {
    const inc = await getIncentiveById(req.params.id);
    if (!inc) return res.status(404).json({ message: 'Incentive not found' });
    return res.json({ incentive: pretty(inc) });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
}

export async function leaderboardHandler(req, res) {
  try {
    return res.json({ leaderboard: await getLeaderboard(req.params.id) });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
}

// Accounts view: won incentives awaiting prize verification/claim, plus the
// already-verified (paid out) ones for history.
export async function claimsHandler(req, res) {
  try {
    const pending = await listPendingClaims();
    const verified = await listVerifiedClaims(Number(req.query.limit) || 60);
    return res.json({
      pending: pending.map(pretty),
      verified: verified.map(pretty),
    });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
}

// Accounts verifies a won incentive's prize payout by uploading a photo of the
// FRO + hard cash received. Photo is base64 (mirrors uploadPaymentScreenshot).
export async function verifyClaimHandler(req, res) {
  try {
    const inc = await getIncentiveById(req.params.id);
    if (!inc) return res.status(404).json({ message: 'Incentive not found' });
    if (inc.status !== 'won') return res.status(400).json({ message: 'Only won incentives can be verified' });
    if (inc.claim_status === 'verified') return res.status(400).json({ message: 'Prize already verified/claimed' });

    const { file_base64, mime_type, remarks } = req.body || {};
    let photoUrl = inc.claim_photo_url || null;

    if (file_base64) {
      const ALLOWED = ['image/jpeg', 'image/png', 'image/webp'];
      const contentType = mime_type || 'image/jpeg';
      if (!ALLOWED.includes(contentType)) {
        return res.status(400).json({ message: `Invalid file type. Allowed: ${ALLOWED.join(', ')}` });
      }
      const buffer = Buffer.from(file_base64, 'base64');
      const ext = contentType.split('/')[1] || 'jpg';
      const fileName = `special_incentive_claims/${req.params.id}_${Date.now()}.${ext}`;

      const bucket = 'worker-documents';
      let { data: uploadData, error: uploadError } = await db.storage.from(bucket).upload(fileName, buffer, { contentType, upsert: true });
      if (uploadError) {
        if (uploadError.message?.includes('bucket')) {
          const { error: bucketError } = await db.storage.createBucket(bucket, { public: true });
          if (bucketError) return res.status(500).json({ message: 'Failed to create storage bucket: ' + bucketError.message });
          const { error: retryError } = await db.storage.from(bucket).upload(fileName, buffer, { contentType, upsert: true });
          if (retryError) return res.status(500).json({ message: 'Upload failed: ' + retryError.message });
        } else {
          return res.status(500).json({ message: 'Upload failed: ' + uploadError.message });
        }
      }
      const { data: urlData } = db.storage.from(bucket).getPublicUrl(fileName);
      photoUrl = urlData?.publicUrl;
      if (!photoUrl) return res.status(500).json({ message: 'Failed to get file URL' });
    }

    const claimed = await claimSpecialIncentive(req.params.id, {
      photoUrl,
      claimedBy: req.user?.id || null,
      remarks: typeof remarks === 'string' && remarks.trim() ? remarks.trim() : null,
    });
    if (!claimed) return res.status(400).json({ message: 'Unable to verify — incentive no longer pending' });
    return res.json({ incentive: pretty(claimed) });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
}

// Super Admin posts the winner's photo (with optional custom message). If no
// message is given, Groq auto-writes a congratulation. The stored row then
// pops up as a celebration on every panel (realtime + 20s poll).
export async function celebrateHandler(req, res) {
  try {
    const inc = await getIncentiveById(req.params.id);
    if (!inc) return res.status(404).json({ message: 'Incentive not found' });
    if (inc.status !== 'won') return res.status(400).json({ message: 'Only won incentives can be celebrated' });
    if (inc.celebrated_at) return res.status(400).json({ message: 'Winner celebration already posted' });

    const { file_base64, mime_type, message } = req.body || {};
    let winnerPhotoUrl = inc.winner_photo_url || null;

    if (file_base64) {
      const ALLOWED = ['image/jpeg', 'image/png', 'image/webp'];
      const contentType = mime_type || 'image/jpeg';
      if (!ALLOWED.includes(contentType)) {
        return res.status(400).json({ message: `Invalid file type. Allowed: ${ALLOWED.join(', ')}` });
      }
      const buffer = Buffer.from(file_base64, 'base64');
      const ext = contentType.split('/')[1] || 'jpg';
      const fileName = `special_incentive_winners/${req.params.id}_${Date.now()}.${ext}`;

      const bucket = 'worker-documents';
      let { error: uploadError } = await db.storage.from(bucket).upload(fileName, buffer, { contentType, upsert: true });
      if (uploadError) {
        if (uploadError.message?.includes('bucket')) {
          const { error: bucketError } = await db.storage.createBucket(bucket, { public: true });
          if (bucketError) return res.status(500).json({ message: 'Failed to create storage bucket: ' + bucketError.message });
          const { error: retryError } = await db.storage.from(bucket).upload(fileName, buffer, { contentType, upsert: true });
          if (retryError) return res.status(500).json({ message: 'Upload failed: ' + retryError.message });
        } else {
          return res.status(500).json({ message: 'Upload failed: ' + uploadError.message });
        }
      }
      const { data: urlData } = db.storage.from(bucket).getPublicUrl(fileName);
      winnerPhotoUrl = urlData?.publicUrl;
      if (!winnerPhotoUrl) return res.status(500).json({ message: 'Failed to get file URL' });
    }

    const customMsg = typeof message === 'string' && message.trim() ? message.trim() : null;
    let congrats = customMsg;
    if (!congrats) {
      try {
        congrats = await generateCongratsMessage({ winnerName: inc.winner_name, title: inc.title, amount: inc.incentive_amount });
      } catch (e) {
        console.error('[special incentive] ai congrats:', e.message);
      }
    }

    const celebrated = await publishWinnerCelebration(req.params.id, { photoUrl: winnerPhotoUrl, message: congrats });
    if (!celebrated) {
      return res.status(400).json({ message: 'Unable to post — winner celebration already published' });
    }
    return res.json({ incentive: pretty(celebrated) });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
}

export async function archiveHandler(req, res) {
  try {
    const archived = await archiveSpecialIncentive(req.params.id, req.user?.id || null);
    if (!archived) return res.status(404).json({ message: 'Incentive not found' });
    return res.json({ incentive: pretty(archived) });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
}

export async function deleteHandler(req, res) {
  try {
    const deleted = await deleteSpecialIncentive(req.params.id);
    if (!deleted) return res.status(404).json({ message: 'Incentive not found' });
    return res.json({ ok: true, id: deleted.id });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
}
