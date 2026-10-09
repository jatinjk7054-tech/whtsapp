import crypto from 'crypto';
import db from '../config/db.js';

const EVENTS_TABLE = 'aud_vote_events';
const PARTICIPANTS_TABLE = 'aud_vote_participants';
const VOTERS_TABLE = 'aud_vote_voters';
const RATINGS_TABLE = 'aud_vote_ratings';

// The five criteria, in the order the audience app shows them and the results
// table lists them. Star criteria are 1..5; timing is a three-way choice that
// resolves to one of those scores.
//
// Timing deliberately sits on the same 1..5 scale as the star rows so the
// overall average is one plain AVG() across all five columns. Storing the score
// rather than a label also means the criterion cannot be quietly dropped from the
// total by a future edit that adds a column without updating the aggregate.
export const TIMING_CHOICES = [
  { key: 'before', label: 'Finished early', score: 1 },
  { key: 'beyond', label: 'Went over time', score: 3 },
  { key: 'on_time', label: 'On time', score: 5 },
];

export const TIMING_SCORES = Object.fromEntries(TIMING_CHOICES.map((c) => [c.key, c.score]));

export const STAR_CRITERIA = [
  { key: 'delivery', label: 'Way of delivering the speech' },
  { key: 'confidence', label: 'Stage confidence' },
  { key: 'clarity', label: 'Clarity of words' },
  { key: 'relevance', label: 'Related to the topic' },
];

export const STAR_KEYS = STAR_CRITERIA.map((c) => c.key);

/**
 * The score behind a timing choice, or null when the choice is not one of the
 * three. Null rather than a fallback: an unknown choice must fail validation
 * loudly, because silently scoring a misspelled key as 1 would quietly drag a
 * speaker's average down.
 */
export const timingScore = (choice) => TIMING_SCORES[String(choice ?? '').trim().toLowerCase()] ?? null;

/** Names are free text from an admin typing and an audience member on a phone. */
export const normName = (v) => String(v ?? '').trim().replace(/\s+/g, ' ');

/**
 * The single overall score for one rating row: the mean of all five criteria.
 *
 * Averages the five equally, so no criterion can be weighted up by being counted
 * twice. Returns null for an incomplete row rather than a partial average, because
 * a 3-criteria mean reads as a real score and is not one.
 */
export const overallScore = (r) => {
  const parts = [...STAR_KEYS.map((k) => Number(r?.[k])), Number(r?.timing)];
  if (parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((sum, n) => sum + n, 0) / parts.length;
};

/**
 * Average the rating rows for one participant into the shape the results table
 * renders: a mean and a count per criterion, plus the mean of the per-rating
 * overall scores.
 *
 * Averages each rating's overall score rather than averaging the five criterion
 * averages. They differ whenever criteria are missing unevenly, and averaging
 * the rows is the one that corresponds to "the score a rater gave", which is what
 * the audience actually saw when they tapped.
 */
export const summarise = (rows = []) => {
  const list = rows.filter(Boolean);
  if (!list.length) {
    return {
      count: 0,
      delivery: null,
      confidence: null,
      clarity: null,
      relevance: null,
      timing: null,
      overall: null,
    };
  }

  const mean = (pick) => {
    const values = list.map(pick).filter((v) => Number.isFinite(v));
    if (!values.length) return null;
    return values.reduce((sum, n) => sum + n, 0) / values.length;
  };

  return {
    count: list.length,
    delivery: mean((r) => Number(r.delivery)),
    confidence: mean((r) => Number(r.confidence)),
    clarity: mean((r) => Number(r.clarity)),
    relevance: mean((r) => Number(r.relevance)),
    timing: mean((r) => Number(r.timing)),
    overall: mean(overallScore),
  };
};

/** Round for display only; never round a stored or ranked value. */
export const round1 = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : null);

// ── events ──────────────────────────────────────────────────────────────────

export const createEvent = async (name, createdBy = null) => {
  const { rows } = await db._pool.query(
    `INSERT INTO ${EVENTS_TABLE} (name, created_by) VALUES ($1, $2) RETURNING *`,
    [normName(name), createdBy ? String(createdBy) : null],
  );
  return rows[0] || null;
};

export const listEvents = async () => {
  const { rows } = await db._pool.query(
    `SELECT e.*,
            (SELECT count(*) FROM ${PARTICIPANTS_TABLE} p WHERE p.event_id = e.id)::int AS participant_count,
            (SELECT count(*) FROM ${RATINGS_TABLE} r WHERE r.event_id = e.id)::int AS rating_count
       FROM ${EVENTS_TABLE} e
      ORDER BY e.status = 'live' DESC, e.created_at DESC`,
  );
  return rows;
};

export const getEvent = async (id) => {
  const { rows } = await db._pool.query(`SELECT * FROM ${EVENTS_TABLE} WHERE id = $1`, [id]);
  return rows[0] || null;
};

/** The event the audience app should be showing: the live one, if there is one. */
export const getLiveEvent = async () => {
  const { rows } = await db._pool.query(
    `SELECT * FROM ${EVENTS_TABLE} WHERE status = 'live' ORDER BY started_at DESC NULLS LAST LIMIT 1`,
  );
  return rows[0] || null;
};

export const renameEvent = async (id, name) => {
  const { rows } = await db._pool.query(
    `UPDATE ${EVENTS_TABLE} SET name = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [id, normName(name)],
  );
  return rows[0] || null;
};

/**
 * Move an event between draft, live and completed.
 *
 * started_at is stamped only on the first transition into live, so a paused and
 * resumed event keeps the time it actually opened. An event cannot be completed
 * while it is still live-and-open in the sense of having no speaker selected is
 * allowed — the caller decides that, not this function.
 */
export const setEventStatus = async (id, status) => {
  const { rows } = await db._pool.query(
    `UPDATE ${EVENTS_TABLE}
        SET status = $2,
            started_at = CASE
              WHEN $2 = 'live' AND started_at IS NULL THEN NOW()
              ELSE started_at
            END,
            completed_at = CASE
              WHEN $2 = 'completed' THEN NOW()
              ELSE NULL
            END,
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [id, status],
  );
  return rows[0] || null;
};

export const deleteEvent = async (id) => {
  // Participants, voters and ratings cascade from here.
  const { rowCount } = await db._pool.query(`DELETE FROM ${EVENTS_TABLE} WHERE id = $1`, [id]);
  return rowCount > 0;
};

// ── participants ────────────────────────────────────────────────────────────

export const listParticipants = async (eventId) => {
  const { rows } = await db._pool.query(
    `SELECT * FROM ${PARTICIPANTS_TABLE} WHERE event_id = $1 ORDER BY order_index`,
    [eventId],
  );
  return rows;
};

export const getParticipant = async (id) => {
  const { rows } = await db._pool.query(`SELECT * FROM ${PARTICIPANTS_TABLE} WHERE id = $1`, [id]);
  return rows[0] || null;
};

/**
 * Add a speaker to the end of the queue.
 *
 * The new order_index is MAX+1 rather than the row count, so a queue with a gap
 * left by a deleted participant does not collide with the UNIQUE (event_id,
 * order_index) constraint.
 */
export const addParticipant = async (eventId, name) => {
  const { rows } = await db._pool.query(
    `INSERT INTO ${PARTICIPANTS_TABLE} (event_id, name, order_index)
     SELECT $1, $2, COALESCE(MAX(order_index), -1) + 1
       FROM ${PARTICIPANTS_TABLE} WHERE event_id = $1
     RETURNING *`,
    [eventId, normName(name)],
  );
  return rows[0] || null;
};

/**
 * Rename a participant in place, keeping their id.
 *
 * An id is referenced by every rating row they have ever collected, so editing a
 * name must never delete-and-recreate the row: that would orphan the ratings and
 * silently drop the speaker out of the results.
 */
export const renameParticipant = async (id, name) => {
  const { rows } = await db._pool.query(
    `UPDATE ${PARTICIPANTS_TABLE} SET name = $2 WHERE id = $1 RETURNING *`,
    [id, normName(name)],
  );
  return rows[0] || null;
};

export const deleteParticipant = async (id) => {
  const { rowCount } = await db._pool.query(`DELETE FROM ${PARTICIPANTS_TABLE} WHERE id = $1`, [id]);
  return rowCount > 0;
};

/**
 * Move one participant to a queue position.
 *
 * Exposed on its own because a reorder cannot be applied as one statement per
 * participant: UNIQUE (event_id, order_index) makes a straight swap collide with
 * the row the next update is about to claim. The controller parks every row on a
 * negative index, then claims the real ones, which is why this accepts negatives.
 */
export const setParticipantOrder = async (id, orderIndex) => {
  await db._pool.query(`UPDATE ${PARTICIPANTS_TABLE} SET order_index = $2 WHERE id = $1`, [id, orderIndex]);
  return getParticipant(id);
};

/**
 * Put a specific speaker on stage.
 *
 * The participant must belong to this event, checked here rather than trusted
 * from the request body, so a crafted id cannot point one event's stage at
 * another event's speaker.
 */
export const setCurrentParticipant = async (eventId, participantId) => {
  const { rows } = await db._pool.query(
    `UPDATE ${EVENTS_TABLE} e
        SET current_participant_id = p.id, updated_at = NOW()
       FROM ${PARTICIPANTS_TABLE} p
      WHERE p.id = $2
        AND p.event_id = e.id
        AND e.id = $1
      RETURNING e.*, p.name AS current_participant_name`,
    [eventId, participantId],
  );
  return rows[0] || null;
};

/**
 * Advance to the next speaker in queue order, or null at the end of the queue.
 *
 * Skips anyone who already has a rating when there is somebody after them who
 * does not, so a mis-click on "next" cannot skip a speaker the audience never
 * got to rate. Falls back to plain next-in-order when the whole queue has been
 * rated, which is the "wrap around and start again" case.
 */
export const nextParticipant = async (eventId, { skipRated = true } = {}) => {
  const event = await getEvent(eventId);
  if (!event) return null;

  const queue = await listParticipants(eventId);
  if (!queue.length) return null;

  const rated = new Set(
    (
      await db._pool.query(
        `SELECT DISTINCT participant_id FROM ${RATINGS_TABLE} WHERE event_id = $1`,
        [eventId],
      )
    ).rows.map((r) => r.participant_id),
  );

  const from = queue.findIndex((p) => p.id === event.current_participant_id);
  // -1 when nothing is on stage, which starts the search at the top of the queue.
  const rotated = [...queue.slice(from + 1), ...queue.slice(0, from + 1)];

  const next =
    (skipRated ? rotated.find((p) => !rated.has(p.id)) : null) ||
    rotated.find((p) => !rated.has(p.id)) ||
    rotated[0] ||
    null;

  return setCurrentParticipant(eventId, next.id);
};

// ── voters ───────────────────────────────────────────────────────────────────

/**
 * Register an audience member against an event, or return the existing row for
 * this device.
 *
 * Idempotent on (event_id, device_token): a page reload or a second tab reuses
 * the same voter row rather than creating a rival identity, which is what stops
 * one person rating the same speaker from two tabs on one phone.
 *
 * The token is a random UUID, not a fingerprint of anything. It is deliberately
 * trivial to defeat by clearing site storage — this is an anti-typo guard for a
 * room full of guests, not an access control.
 */
export const joinEvent = async (eventId, name, deviceToken = null) => {
  const token = deviceToken || crypto.randomUUID();
  const { rows } = await db._pool.query(
    `INSERT INTO ${VOTERS_TABLE} (event_id, name, device_token)
     VALUES ($1, $2, $3)
     ON CONFLICT (event_id, device_token)
     DO UPDATE SET name = EXCLUDED.name
     RETURNING *`,
    [eventId, normName(name), token],
  );
  return rows[0] || null;
};

export const getVoter = async (eventId, deviceToken) => {
  if (!deviceToken) return null;
  const { rows } = await db._pool.query(
    `SELECT * FROM ${VOTERS_TABLE} WHERE event_id = $1 AND device_token = $2`,
    [eventId, deviceToken],
  );
  return rows[0] || null;
};

/**
 * The name this device has registered under most recently, in ANY event.
 *
 * This exists because the two halves of the identity have different lifetimes.
 * The device token is stored in localStorage and outlives any single event,
 * while a voter row is scoped to one event (UNIQUE is on event_id+device_token).
 * So the first time somebody rates after a new event opens, they are a known
 * device holding a token that names no voter in the event now running.
 *
 * Ordered by id DESC rather than created_at: id is monotonic and cannot be
 * defeated by two rows written in the same clock tick, which matters because
 * these inserts happen in the same millisecond when a phone submits fast.
 *
 * Returns the newest row, so a name corrected during an earlier event is the one
 * carried forward.
 */
export const findVoterByDevice = async (deviceToken) => {
  if (!deviceToken) return null;
  const { rows } = await db._pool.query(
    `SELECT * FROM ${VOTERS_TABLE} WHERE device_token = $1 ORDER BY id DESC LIMIT 1`,
    [deviceToken],
  );
  return rows[0] || null;
};

export const countVoters = async (eventId) => {
  const { rows } = await db._pool.query(
    `SELECT count(*)::int AS n FROM ${VOTERS_TABLE} WHERE event_id = $1`,
    [eventId],
  );
  return rows[0]?.n ?? 0;
};

// ── ratings ──────────────────────────────────────────────────────────────────

/**
 * Record one audience member's scores for one speaker.
 *
 * Uniqueness is the database's job (UNIQUE participant_id, voter_id), so a
 * double-tap, a second tab and a retried request all collapse to a single
 * rating instead of needing a read-then-write here that two concurrent requests
 * could both pass.
 *
 * voterId is resolved by the controller from the device token rather than taken
 * from the body, so a caller cannot submit as somebody else's voter row.
 */
export const insertRating = async ({ eventId, participantId, voterId, delivery, confidence, clarity, relevance, timing, comment = null }) => {
  const { rows } = await db._pool.query(
    `INSERT INTO ${RATINGS_TABLE}
       (event_id, participant_id, voter_id, delivery, confidence, clarity, relevance, timing, comment)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      eventId,
      participantId,
      voterId,
      delivery,
      confidence,
      clarity,
      relevance,
      timing,
      comment ? String(comment).trim().slice(0, 1000) : null,
    ],
  );
  return rows[0] || null;
};

export const listRatings = async (eventId, participantId = null) => {
  const { rows } = await db._pool.query(
    `SELECT * FROM ${RATINGS_TABLE}
      WHERE event_id = $1 AND ($2::int IS NULL OR participant_id = $2::int)
      ORDER BY id`,
    [eventId, participantId],
  );
  return rows;
};

/** Which participants of an event have at least one rating. */
export const ratedParticipantIds = async (eventId) => {
  const { rows } = await db._pool.query(
    `SELECT DISTINCT participant_id FROM ${RATINGS_TABLE} WHERE event_id = $1`,
    [eventId],
  );
  return rows.map((r) => r.participant_id);
};

/** Has this device already rated this speaker? Drives the "already rated" screen. */
export const hasRated = async (participantId, voterId) => {
  const { rows } = await db._pool.query(
    `SELECT 1 FROM ${RATINGS_TABLE} WHERE participant_id = $1 AND voter_id = $2 LIMIT 1`,
    [participantId, voterId],
  );
  return rows.length > 0;
};

/**
 * Per-participant averages for one event, in one query.
 *
 * The whole results table is one round trip rather than a query per speaker,
 * because the admin page refreshes on a timer while the event is live and a hall
 * of guests is submitting at the same time.
 *
 * LEFT JOIN, not INNER: a speaker nobody has rated yet still has to appear, with
 * null averages, or the board would look like it had fewer speakers than the
 * queue does and the admin would think a speaker was missing.
 */
export const aggregateResults = async (eventId) => {
  const { rows } = await db._pool.query(
    `SELECT p.id,
            p.name,
            p.order_index,
            count(r.id)::int AS rating_count,
            AVG(r.delivery)::float   AS delivery,
            AVG(r.confidence)::float AS confidence,
            AVG(r.clarity)::float    AS clarity,
            AVG(r.relevance)::float  AS relevance,
            AVG(r.timing)::float     AS timing,
            AVG((r.delivery + r.confidence + r.clarity + r.relevance + r.timing) / 5.0)::float AS overall
       FROM ${PARTICIPANTS_TABLE} p
       LEFT JOIN ${RATINGS_TABLE} r ON r.participant_id = p.id
      WHERE p.event_id = $1
      GROUP BY p.id, p.name, p.order_index
      ORDER BY p.order_index`,
    [eventId],
  );
  return rows;
};