import db from '../config/db.js';
import groq from '../config/groq.js';
import {
  getSettings,
  updateSettings,
} from '../models/incentiveSettingsModel.js';
import {
  getAllSlabs,
  getSlabById,
  createSlab,
  updateSlab,
  deleteSlab,
  updateAllSlabs,
  getSlabFros,
  setSlabFros,
  getStoppedSlabIds,
  clearSlabStop,
  clearAllSlabStops,
} from '../models/incentiveSlabModel.js';
import {
  getDailySummary,
  getFroDetail,
  getCurrentChampions,
  getFroRanks,
  announceChampion,
  notifyRangeRuleChange,
  stopSlabCompetition,
  stopAllSlabsCompetition,
} from '../services/leadIncentiveService.js';
import {
  getAnnouncements,
  getAnnouncementById,
  updateAnnouncementCelebration,
  deleteAnnouncement,
} from '../models/leadChampionModel.js';
import { ensureLowLeadRangeActive } from '../bootstrap/ensureSpecialIncentiveSchema.js';

// ─── Settings ──────────────────────────────────────────────

export async function getSettingsHandler(req, res) {
  try {
    const settings = await getSettings();
    return res.json(settings);
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
}

export async function updateSettingsHandler(req, res) {
  try {
    const { lead_rate, min_lead_amount, champion_bonus } = req.body || {};
    const updated = await updateSettings({ lead_rate, min_lead_amount, champion_bonus });
    return res.json(updated);
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
}

// ─── Slabs CRUD ────────────────────────────────────────────

export async function listSlabsHandler(req, res) {
  try {
    // Self-heal: guarantee the ₹1–₹20,000 range exists & is active before it is
    // listed, so a soft-deleted/missing low band reappears the moment the Lead
    // Incentive page loads (no backend restart required).
    try { await ensureLowLeadRangeActive(); } catch (e) { console.error('[lead rules heal]', e?.message); }
    const slabs = await getAllSlabs();
    return res.json(slabs);
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
}

const numOr = (v, dflt) => {
  if (v === undefined || v === null || v === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
};

export async function createSlabHandler(req, res) {
  try {
    const { min_amount, max_amount, incentive_amount, amount_to_win } = req.body || {};
    if (min_amount === undefined || max_amount === undefined) {
      return res.status(400).json({ message: 'min_amount and max_amount are required' });
    }
    if (Number(min_amount) >= Number(max_amount)) {
      return res.status(400).json({ message: 'min_amount must be less than max_amount' });
    }

    // Check for overlapping slabs
    const existing = await getAllSlabs();
    const overlap = existing.find(s =>
      s.is_active &&
      Number(min_amount) < Number(s.max_amount) &&
      Number(max_amount) > Number(s.min_amount)
    );
    if (overlap) {
      return res.status(400).json({
        message: `Overlap with existing slab ₹${Number(overlap.min_amount).toLocaleString('en-IN')} – ₹${Number(overlap.max_amount).toLocaleString('en-IN')}`,
      });
    }

    const slab = await createSlab({
      min_amount: Number(min_amount),
      max_amount: Number(max_amount),
      incentive_amount: Number(incentive_amount) || 0,
      amount_to_win: numOr(req.body.amount_to_win, 1500),
    });
    // A new range may re-bucket FROs — tell the ones landing in it.
    try { await notifyRangeRuleChange({ slab }); } catch (e) { console.error('[lead rules notify]', e?.message); }
    return res.status(201).json(slab);
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
}

export async function updateSlabHandler(req, res) {
  try {
    const { min_amount, max_amount, incentive_amount, amount_to_win } = req.body || {};
    if (min_amount === undefined || max_amount === undefined) {
      return res.status(400).json({ message: 'min_amount and max_amount are required' });
    }
    if (Number(min_amount) >= Number(max_amount)) {
      return res.status(400).json({ message: 'min_amount must be less than max_amount' });
    }

    // Check overlap excluding self
    const existing = await getAllSlabs();
    const overlap = existing.find(s =>
      s.is_active &&
      s.id !== req.params.id &&
      Number(min_amount) < Number(s.max_amount) &&
      Number(max_amount) > Number(s.min_amount)
    );
    if (overlap) {
      return res.status(400).json({
        message: `Overlap with existing slab ₹${Number(overlap.min_amount).toLocaleString('en-IN')} – ₹${Number(overlap.max_amount).toLocaleString('en-IN')}`,
      });
    }

    const oldSlab = await getSlabById(req.params.id);

    // Optional competition window (⏱ Start/End Time control): a value sets the
    // start/end instant, null or '' clears it back to "not scheduled/ended".
    const startedAt = req.body.started_at !== undefined
      ? (req.body.started_at === null || req.body.started_at === '' ? null : new Date(req.body.started_at).toISOString())
      : undefined;
    const endedAt = req.body.ended_at !== undefined
      ? (req.body.ended_at === null || req.body.ended_at === '' ? null : new Date(req.body.ended_at).toISOString())
      : undefined;

    const slab = await updateSlab(req.params.id, {
      min_amount: Number(min_amount),
      max_amount: Number(max_amount),
      incentive_amount: Number(incentive_amount) || 0,
      amount_to_win: numOr(req.body.amount_to_win, 1500),
      started_at: startedAt,
      ended_at: endedAt,
    });
    if (!slab) return res.status(404).json({ message: 'Slab not found' });

    // Configuring a range restarts its competition (clears any stopped marker).
    try { await clearSlabStop(req.params.id); } catch (e) { console.error('[lead rules clear stop]', e?.message); }

    // Ping ONLY this range's FROs when the win target, prize or Start/End
    // window changed — other ranges are never disturbed.
    if (oldSlab) {
      const winChanged = Number(oldSlab.amount_to_win) !== Number(slab.amount_to_win);
      const prizeChanged = Number(oldSlab.incentive_amount) !== Number(slab.incentive_amount);
      const normT = (v) => v ? new Date(v).getTime() : null;
      const windowChanged = normT(oldSlab.started_at) !== normT(slab.started_at)
        || normT(oldSlab.ended_at) !== normT(slab.ended_at);
      if (winChanged || prizeChanged || windowChanged) {
        try { await notifyRangeRuleChange({ slab }); } catch (e) { console.error('[lead rules notify]', e?.message); }
      }
    }
    return res.json(slab);
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
}

export async function deleteSlabHandler(req, res) {
  try {
    const slab = await deleteSlab(req.params.id);
    if (!slab) return res.status(404).json({ message: 'Slab not found' });
    return res.json({ ok: true, id: slab.id });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
}

export async function applyAllSlabsHandler(req, res) {
  try {
    const { amount_to_win, started_at, ended_at } = req.body || {};
    const hasWinAt = amount_to_win !== undefined && amount_to_win !== '';
    const hasTimes = started_at !== undefined;
    if (!hasWinAt && !hasTimes) {
      return res.status(400).json({ message: 'Provide amount_to_win, or started_at/ended_at' });
    }
    if (hasWinAt) {
      const winAt = Number(amount_to_win);
      if (!(winAt > 0)) {
        return res.status(400).json({ message: 'Win On (₹) must be more than 0' });
      }
    }
    const startedAtVal = started_at !== undefined
      ? (started_at === null || started_at === '' ? null : new Date(started_at).toISOString())
      : undefined;
    const endedAtVal = ended_at !== undefined
      ? (ended_at === null || ended_at === '' ? null : new Date(ended_at).toISOString())
      : undefined;

    const slabs = await updateAllSlabs({
      amount_to_win: hasWinAt ? Number(amount_to_win) : undefined,
      started_at: startedAtVal,
      ended_at: endedAtVal,
    });
    // Setting a new competition window re-opens any range that was stopped for
    // today (the scheduled race takes over). Value-only applies keep the previous behaviour.
    if (hasTimes) {
      try { await clearAllSlabStops(); } catch (e) { console.error('[lead rules clear stops]', e?.message); }
    }
    // Every FRO gets one combined popup listing all ranges with the new value.
    if (hasWinAt) {
      try { await notifyRangeRuleChange({ slabs }); }
      catch (e) { console.error('[lead rules notify]', e?.message); }
    }
    return res.json({ ok: true, count: slabs.length, slabs });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
}

// Admin stops a range's live competition. Removes the range from the FRO live
// leaderboard for the date, deletes today's champion announcements for it and
// clears the rule/winner popups from every panel's notification feed.
export async function stopSlabCompetitionHandler(req, res) {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const result = await stopSlabCompetition({ slabId: req.params.id, date, userId: req.user?.id });
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
}

// Admin stops EVERY live range competition for a date at once.
export async function stopAllSlabsCompetitionHandler(req, res) {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const result = await stopAllSlabsCompetition({ date, userId: req.user?.id });
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
}

// ─── Lead Summary ──────────────────────────────────────────

export async function dailySummaryHandler(req, res) {
  try {
    // Same self-heal as listSlabsHandler — the page fetches slabs + summary in
    // parallel, so heal here too to avoid a stale first summary.
    try { await ensureLowLeadRangeActive(); } catch (e) { console.error('[lead rules heal]', e?.message); }
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const summary = await getDailySummary(date);

    // Enrich with worker photos so the history leaderboard can show the
    // winner's image (like "Sir ka Incentive" winner display).
    const ids = [...new Set([
      ...(summary.fros || []).map(f => f.fro_id),
      ...(summary.champions || []).map(c => c.fro_id),
    ])];
    if (ids.length > 0) {
      const { data: workers } = await db.from('workers').select('id, photo_url').in('id', ids);
      const photoMap = {};
      for (const w of workers || []) photoMap[w.id] = w.photo_url || null;
      summary.fros = (summary.fros || []).map(f => ({ ...f, photo_url: photoMap[f.fro_id] || null }));
      summary.champions = (summary.champions || []).map(c => ({ ...c, photo_url: photoMap[c.fro_id] || null }));
    } else {
      summary.fros = (summary.fros || []).map(f => ({ ...f, photo_url: null }));
      summary.champions = (summary.champions || []).map(c => ({ ...c, photo_url: null }));
    }

    return res.json(summary);
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
}

export async function froDetailHandler(req, res) {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const detail = await getFroDetail(req.params.id, date);
    if (!detail) return res.status(404).json({ message: 'FRO not found' });
    return res.json(detail);
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
}

// FRO-facing "my summary" for the Lead Incentive dashboard. Lets the logged-in
// FRO see their own daily numbers, their range, whether today's competition is
// live, and whether they are today's champion (includes the champion bonus).
export async function myLeadSummaryHandler(req, res) {
  try {
    const froId = req.user?.id;
    if (!froId) return res.status(401).json({ message: 'Unauthorized' });

    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const detail = await getFroDetail(froId, date);
    if (!detail) return res.status(404).json({ message: 'FRO not found' });

    // Same daily computation used everywhere → consistent champion/prize figures.
    const summary = await getDailySummary(date);
    const champ = (summary.champions || []).find(c => String(c.fro_id) === String(froId));

    const isChampion = !!champ;
    // Flat model: only the range's flat prize (incentive_amount) is paid, and only
    // to the range's champion. lead_incentive / champion_bonus are always 0.
    const totalIncentive = isChampion ? Number(champ.total_incentive || 0) : 0;

    // Is this FRO's range competition live right now? Mirrors getFroRanks logic:
    // needs a started_at in the past, an ended_at (if set) still in the future,
    // and the range must not have been stopped for today.
    const slab = detail.slab;
    let isLive = false;
    if (slab && slab.started_at) {
      const nowMs = Date.now();
      const started = new Date(slab.started_at).getTime();
      const ended = slab.ended_at ? new Date(slab.ended_at).getTime() : null;
      isLive = started <= nowMs && (!ended || ended > nowMs);
    }
    if (isLive && slab) {
      try {
        const stopped = await getStoppedSlabIds();
        const datePrefix = String(date).slice(0, 10);
        const stoppedToday = (stopped || []).some(s =>
          String(s.stopped_date).slice(0, 10) === datePrefix && String(s.id) === String(slab.id)
        );
        if (stoppedToday) isLive = false;
      } catch (e) {
        console.error('[lead my summary] stopped check:', e?.message);
      }
    }

    return res.json({
      ...detail,
      is_live: isLive,
      is_champion: isChampion,
      lead_incentive: isChampion ? Number(champ.lead_incentive || 0) : 0,
      slab_bonus: isChampion ? Number(champ.slab_bonus || 0) : 0,
      champion_bonus: isChampion ? Number(champ.champion_bonus || 0) : 0,
      amount_to_win: detail.slab?.amount_to_win != null ? Number(detail.slab.amount_to_win) : 1500,
      total_incentive: totalIncentive,
    });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
}

// FRO-facing daily leaderboard (corner card + big popup, any active role).
export async function leaderboardHandler(req, res) {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const includeWon = req.query.includeWon === '1' || req.query.include_won === '1';
    const ranks = await getFroRanks(date, { includeWon });
    return res.json(ranks);
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
}

// Get the current/announced range champions (FRO-facing, any role).
export async function currentChampionHandler(req, res) {
  try {
    const date = req.query.date || null;
    const champions = await getCurrentChampions(date);
    const withPhotos = [];
    for (const champion of champions) {
      let winner_photo_url = null;
      if (champion && champion.fro_worker_id) {
        try {
          const { data: winners } = await db
            .from('workers')
            .select('id, photo_url')
            .eq('id', champion.fro_worker_id);
          winner_photo_url = (winners && winners[0]?.photo_url) || null;
        } catch (e) {
          console.error('[lead champion] fetch photo:', e?.message);
        }
      }
      // Prefer the celebration photo uploaded by Super Admin at Send time,
      // falling back to the winner's profile photo.
      withPhotos.push({ ...champion, winner_photo_url: champion.winner_photo_url || winner_photo_url });
    }
    return res.json({ champions: withPhotos });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
}

// Admin announces today's range winners. Locks each range's first-hitter into a
// snapshot + notifies all panels.
export async function announceChampionHandler(req, res) {
  try {
    const { date, message } = req.body || {};
    const result = await announceChampion({ date, message, userId: req.user?.id });
    if (result.error) {
      return res.status(400).json({ message: result.error });
    }
    return res.status(201).json(result);
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
}

// FROs assigned to compete in a specific range (⚙️ Configure).
export async function getSlabFrosHandler(req, res) {
  try {
    const fros = await getSlabFros(req.params.id);
    return res.json({ fro_ids: fros });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
}

export async function setSlabFrosHandler(req, res) {
  try {
    const { fro_ids } = req.body || {};
    if (!Array.isArray(fro_ids)) {
      return res.status(400).json({ message: 'fro_ids must be an array' });
    }
    const saved = await setSlabFros(req.params.id, fro_ids);
    return res.json({ ok: true, fro_ids: saved });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
}

// Full history of champion announcements (live-updating section source).
export async function championHistoryHandler(req, res) {
  try {
    const history = await getAnnouncements();
    return res.json(history);
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
}

// Hard-delete an announcement. Also removes the FRO-facing champion banner for
// that date AND the champion notification rows every panel got at announce time
// (bell entries type='lead_champion'), so deleting the champion removes it from
// all sides immediately. notification_log is realtime-enabled, so open panels
// drop the bell entry live.
export async function deleteChampionHandler(req, res) {
  try {
    const row = await deleteAnnouncement(req.params.id);
    if (!row) return res.status(404).json({ message: 'Announcement not found' });

    try {
      await db.from('notification_log').delete()
        .eq('type', 'lead_champion')
        .eq('reference_id', String(row.id));
    } catch (e) {
      console.error('[lead champion] cleanup notifications:', e?.message);
    }

    return res.json({ ok: true, id: row.id });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
}

// AI-written congratulation for a range winner (Super Admin composer in the
// History section). Falls back to a template so the button never hard-fails.
export async function generateChampionCongratsHandler(req, res) {
  try {
    const row = await getAnnouncementById(req.params.id);
    if (!row) return res.status(404).json({ message: 'Announcement not found' });
    const prize = Number(row.slab_bonus || row.total_incentive || 0);
    try {
      const model = process.env.GROQ_CONGRATS_MODEL || process.env.GROQ_SPELLING_MODEL || 'openai/gpt-oss-120b';
      const completion = await groq.chat.completions.create({
        messages: [
          {
            role: 'system',
            content:
              'You write warm, short congratulations (2-3 sentences) for FRO fundraising officers who won a collection incentive at a donation NGO. Mention the winner by name, the range and the prize. Cheerful, proud, inspiring. Use at most one emoji. Plain text only, no quotes, no markdown.',
          },
          { role: 'user', content: `Winner: ${row.fro_name || 'The winner'}\nRange: ${row.slab_label || 'the incentive range'}\nPrize: ₹${prize}` },
        ],
        model,
        max_tokens: 160,
        temperature: 0.85,
      });
      const text = (completion.choices?.[0]?.message?.content || '').trim();
      if (text) return res.json({ message: text });
    } catch (e) {
      console.error('[lead champion] ai congrats:', e.message);
    }
    return res.json({
      message: `Heartiest congratulations to ${row.fro_name || 'our champion'} for winning the ${row.slab_label || 'incentive range'} with a prize of ₹${prize.toLocaleString('en-IN')}! Your hard work inspires the whole team. 🎉`,
    });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
}

// Super Admin publishes a winner celebration (photo + message) exactly once.
// The stored row pops up on every panel via realtime; each user sees it once
// (client-side seen-set) and it never returns on reload/login.
export async function celebrateChampionHandler(req, res) {
  try {
    const row = await getAnnouncementById(req.params.id);
    if (!row) return res.status(404).json({ message: 'Announcement not found' });
    if (row.celebrated_at) return res.status(400).json({ message: 'Celebration already sent' });

    const { file_base64, mime_type, message } = req.body || {};
    let photoUrl = row.winner_photo_url || null;

    if (file_base64) {
      const ALLOWED = ['image/jpeg', 'image/png', 'image/webp'];
      const contentType = mime_type || 'image/jpeg';
      if (!ALLOWED.includes(contentType)) {
        return res.status(400).json({ message: `Invalid file type. Allowed: ${ALLOWED.join(', ')}` });
      }
      const buffer = Buffer.from(file_base64, 'base64');
      const ext = contentType.split('/')[1] || 'jpg';
      const fileName = `lead_champion_winners/${req.params.id}_${Date.now()}.${ext}`;

      const bucket = 'worker-documents';
      const { error: uploadError } = await db.storage.from(bucket).upload(fileName, buffer, { contentType, upsert: true });
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

    const celebrated = await updateAnnouncementCelebration(req.params.id, { photoUrl, message });
    if (!celebrated) return res.status(400).json({ message: 'Celebration already sent' });
    return res.json({ announcement: celebrated });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
}
