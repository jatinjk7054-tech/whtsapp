import {
  createEvent,
  listEvents,
  getEvent,
  getLiveEvent,
  renameEvent,
  setEventStatus,
  deleteEvent,
  listParticipants,
  getParticipant,
  addParticipant,
  renameParticipant,
  deleteParticipant,
  setCurrentParticipant,
  setParticipantOrder,
  nextParticipant as modelNextParticipant,
  joinEvent,
  getVoter,
  findVoterByDevice,
  countVoters,
  insertRating,
  ratedParticipantIds,
  hasRated,
  aggregateResults,
  timingScore,
  normName,
  round1,
  STAR_CRITERIA,
  TIMING_CHOICES,
} from '../models/audienceVotingModel.js';

// Every response carries server_now so the audience app can tell a stale tab from
// a live one, and so a phone with a wrong clock still shows the right clock.
const withServerNow = (payload) => ({ ...payload, server_now: new Date().toISOString() });

const actorOf = (req) => req.user?.login_id || req.user?.email || req.user?.name || null;

const asInt = (v) => {
  const n = Number.parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * A refused request, with a machine-readable `code` alongside the message.
 *
 * The code is what the audience app branches on. Three different situations all
 * arrive as 409 from /rate — already rated, nobody on stage, the speaker changed
 * mid-form — and the first wants a "thank you" screen while the other two want
 * a retry. Status alone cannot tell them apart; carrying `code` through is the
 * same convention the HR WhatsApp endpoint already uses.
 */
const bad = (res, message, status = 400, code) =>
  res.status(status).json({ message, ...(code ? { code } : {}) });

/** The criteria list, so the audience app and the results table cannot drift apart. */
const criteriaShape = () => ({
  star: STAR_CRITERIA.map((c) => ({ key: c.key, label: c.label })),
  timing: TIMING_CHOICES.map((c) => ({ key: c.key, label: c.label, score: c.score })),
});

const shapeResults = (rows) =>
  rows.map((r) => ({
    participant_id: r.id,
    name: r.name,
    order_index: r.order_index,
    rating_count: r.rating_count,
    delivery: round1(r.delivery),
    confidence: round1(r.confidence),
    clarity: round1(r.clarity),
    relevance: round1(r.relevance),
    timing: round1(r.timing),
    overall: round1(r.overall),
  }));

// ── public: what the audience app polls ─────────────────────────────────────

/**
 * The whole public state in one small payload.
 *
 * Polled every few seconds by every phone in the room, so it returns only what a
 * rater needs: is anything running, whose turn it is, and — for this device —
 * whether they have already rated them. It deliberately does NOT return anyone's
 * scores or the averages, because a live leaderboard shown to the room turns the
 * later speakers into a popularity contest.
 *
 * "Nothing running" is a 200 with `live: false`, not a 404. A 404 is ambiguous
 * between "no event yet, keep waiting" and "this route is not mounted on the
 * server you are talking to", and those two need opposite responses — the first
 * is normal before every event, the second is a deployment fault. Making the
 * resting state a success means the app never has to tell them apart.
 */
export const getStatus = async (req, res) => {
  const event = await getLiveEvent();
  if (!event) return res.json(withServerNow({ live: false, event: null, current: null, next: null }));

  const participants = await listParticipants(event.id);
  const current = participants.find((p) => p.id === event.current_participant_id) || null;
  // Whoever the app should announce next, so the confirmation screen can say
  // "next up" instead of leaving the rater staring at a dead end.
  const next =
    (current
      ? participants.find((p) => p.order_index > current.order_index)
      : participants[0]) || null;

  // The device token is a query parameter here because this endpoint has no
  // request body and no auth header — it is a plain GET the browser hits on a
  // timer. It identifies the phone, not a person, and grants no access.
  const deviceToken = typeof req.query.device_token === 'string' ? req.query.device_token : null;
  const voter = await getVoter(event.id, deviceToken);
  const alreadyRated = !!(voter && current && (await hasRated(current.id, voter.id)));

  return res.json(
    withServerNow({
      live: true,
      event: {
        id: event.id,
        name: event.name,
        status: event.status,
        participant_count: participants.length,
        voter_count: await countVoters(event.id),
        speakers_done: (await ratedParticipantIds(event.id)).length,
      },
      current: current ? { id: current.id, name: current.name, already_rated: alreadyRated } : null,
      next: next && next.id !== current?.id ? { id: next.id, name: next.name } : null,
      joined: !!voter,
      name: voter ? voter.name : null,
      criteria: criteriaShape(),
    }),
  );
};

/**
 * Join the event: register a display name against this device and get back the
 * token every later call carries.
 *
 * Idempotent per device, so a reload or a second tab keeps the same identity and
 * therefore the same one-rating-per-speaker limit.
 */
export const join = async (req, res) => {
  const name = normName(req.body?.name);
  if (!name) return bad(res, 'Enter your name to continue');
  if (name.length > 80) return bad(res, 'That name is too long');

  const event = await getLiveEvent();
  if (!event) return bad(res, 'Voting is not open at the moment', 409, 'no_event');

  const deviceToken = typeof req.body?.device_token === 'string' ? req.body.device_token : null;
  const voter = await joinEvent(event.id, name, deviceToken);
  if (!voter) return bad(res, 'Could not join the event', 500);

  return res.status(201).json(withServerNow({ id: voter.id, name: voter.name, device_token: voter.device_token }));
};

/**
 * Record one rating for the speaker currently on stage.
 *
 * The speaker is taken from the event, not from the request body. If the admin
 * advanced the stage while somebody was mid-form, their answer is recorded
 * against whoever is on stage now — or refused if nobody is. Silently re-targeting
 * a stale form to a different speaker would attribute one person's scores to
 * another, so a stage change mid-rating is rejected instead.
 */
export const rate = async (req, res) => {
  const body = req.body || {};
  const deviceToken = typeof body.device_token === 'string' ? body.device_token : '';
  if (!deviceToken) return bad(res, 'Join the event before rating');

  const event = await getLiveEvent();
  if (!event) return bad(res, 'Voting is not open at the moment', 409, 'no_event');

  const participantId = asInt(event.current_participant_id);
  if (!participantId) return bad(res, 'Nobody is on stage yet — wait for the next speaker', 409, 'no_speaker');

  // Reject a rating aimed at a speaker who is no longer the one on stage.
  const askedFor = asInt(body.participant_id);
  if (askedFor && askedFor !== participantId) {
    return bad(res, 'The next speaker has started — your scores were not saved', 409, 'stale_speaker');
  }

  let voter = await getVoter(event.id, deviceToken);

  // Carry the identity forward across events.
  //
  // The device token survives in localStorage but a voter row is scoped to one
  // event, so the first rating after a new event opens looks like an unknown
  // device. Re-enrolling the same person under the name they already gave is
  // the behaviour the room expects: one link for the whole ceremony, and nobody
  // should be asked their name again between sessions.
  //
  // Done here, on the rating, and not in /status: /status is polled every few
  // seconds by every phone, and enrolling there would count people who merely
  // held the page open as "joined".
  if (!voter) {
    const previous = await findVoterByDevice(deviceToken);
    if (previous) voter = await joinEvent(event.id, previous.name, deviceToken);
  }

  if (!voter) {
    return bad(res, 'Join the event before rating', 401, 'not_joined');
  }

  const stars = {};
  for (const { key } of STAR_CRITERIA) {
    const n = Number(body[key]);
    if (!Number.isInteger(n) || n < 1 || n > 5) {
      return bad(res, 'Give every criterion a rating from 1 to 5', 400, 'incomplete');
    }
    stars[key] = n;
  }

  const timing = timingScore(body.timing);
  if (timing == null) return bad(res, 'Choose before time, on time, or beyond time', 400, 'incomplete');

  try {
    await insertRating({
      eventId: event.id,
      participantId,
      voterId: voter.id,
      ...stars,
      timing,
      comment: body.comment,
    });
    return res.status(201).json(withServerNow({ message: 'Rating saved', participant_id: participantId }));
  } catch (e) {
    // 23505 is the UNIQUE (participant_id, voter_id) violation. It means this
    // phone has already rated this speaker — a double tap, a second tab or a
    // retried request, not an error worth showing as one.
    if (e?.code === '23505') {
      return bad(res, 'You have already rated this speaker', 409, 'already_rated');
    }
    throw e;
  }
};

// ── admin ───────────────────────────────────────────────────────────────────

export const listAllEvents = async (req, res) => {
  const events = await listEvents();
  return res.json(withServerNow({ events }));
};

export const createNewEvent = async (req, res) => {
  const name = normName(req.body?.name);
  if (!name) return bad(res, 'Give the event a name');
  const event = await createEvent(name, actorOf(req));
  return res.status(201).json({ message: 'Event created', event });
};

export const editEvent = async (req, res) => {
  const id = asInt(req.params.id);
  if (!id) return bad(res, 'Bad event id');
  const name = normName(req.body?.name);
  if (!name) return bad(res, 'Give the event a name');
  const event = await renameEvent(id, name);
  if (!event) return res.status(404).json({ message: 'Event not found' });
  return res.json({ message: 'Event renamed', event });
};

export const removeEvent = async (req, res) => {
  const id = asInt(req.params.id);
  if (!id) return bad(res, 'Bad event id');
  const event = await getEvent(id);
  if (!event) return res.status(404).json({ message: 'Event not found' });
  if (event.status === 'live') {
    return bad(res, 'Stop the event before deleting it', 409);
  }
  await deleteEvent(id);
  return res.json({ message: 'Event deleted' });
};

/** Start, stop or complete an event. */
export const changeEventStatus = async (req, res) => {
  const id = asInt(req.params.id);
  if (!id) return bad(res, 'Bad event id');

  const action = String(req.params.action || '').toLowerCase();
  const targets = { start: 'live', stop: 'draft', complete: 'completed' };
  const status = targets[action];
  if (!status) return bad(res, 'Unknown action');

  const existing = await getEvent(id);
  if (!existing) return res.status(404).json({ message: 'Event not found' });

  if (action === 'start') {
    const participants = await listParticipants(id);
    if (!participants.length) {
      return bad(res, 'Add at least one speaker before starting', 409);
    }
    // Restarting an event that already has somebody on stage keeps them there,
    // so a stop/start mid-event does not silently reset the room to the top of
    // the queue.
    if (!existing.current_participant_id) {
      await setCurrentParticipant(id, participants[0].id);
    }
  }

  const event = await setEventStatus(id, status);
  return res.json({ message: `Event ${action === 'start' ? 'started' : action === 'stop' ? 'stopped' : 'completed'}`, event });
};

export const listEventParticipants = async (req, res) => {
  const id = asInt(req.params.id);
  if (!id) return bad(res, 'Bad event id');
  const [participants, rated, voters] = await Promise.all([
    listParticipants(id),
    ratedParticipantIds(id),
    countVoters(id),
  ]);
  return res.json(
    withServerNow({
      participants: participants.map((p) => ({ ...p, rated: rated.includes(p.id) })),
      voter_count: voters,
    }),
  );
};

export const createParticipant = async (req, res) => {
  const id = asInt(req.params.id);
  if (!id) return bad(res, 'Bad event id');
  const name = normName(req.body?.name);
  if (!name) return bad(res, 'Enter a name');
  if (name.length > 120) return bad(res, 'That name is too long');
  const participant = await addParticipant(id, name);
  return res.status(201).json({ message: 'Speaker added', participant });
};

export const editParticipant = async (req, res) => {
  const participantId = asInt(req.params.participantId);
  if (!participantId) return bad(res, 'Bad speaker id');
  const name = normName(req.body?.name);
  if (!name) return bad(res, 'Enter a name');
  const participant = await renameParticipant(participantId, name);
  if (!participant) return res.status(404).json({ message: 'Speaker not found' });
  return res.json({ message: 'Speaker renamed', participant });
};

export const removeParticipant = async (req, res) => {
  const participantId = asInt(req.params.participantId);
  if (!participantId) return bad(res, 'Bad speaker id');
  const ok = await deleteParticipant(participantId);
  if (!ok) return res.status(404).json({ message: 'Speaker not found' });
  return res.json({ message: 'Speaker removed' });
};

/** Put a named speaker on stage. */
export const setCurrent = async (req, res) => {
  const id = asInt(req.params.id);
  if (!id) return bad(res, 'Bad event id');
  const participantId = asInt(req.body?.participant_id);
  if (!participantId) return bad(res, 'Choose a speaker');

  const event = await setCurrentParticipant(id, participantId);
  // Distinguishes "no such speaker in this event" from "no event", which both
  // produce no updated row.
  if (!event) return res.status(404).json({ message: 'Speaker not found in this event' });
  return res.json({
    message: 'Now on stage',
    current_participant_id: event.current_participant_id,
    current_participant_name: event.current_participant_name,
  });
};

/**
 * Move to the next speaker.
 *
 * `wrap` chooses between "skip anyone already rated" (the default: Next means
 * the next person who still needs scores) and strict queue order. Reordering is
 * accepted as an explicit ids array; each id is checked against this event before
 * anything is written, so a crafted list cannot pull another event's speakers
 * into this queue.
 */
export const advanceParticipant = async (req, res) => {
  const id = asInt(req.params.id);
  if (!id) return bad(res, 'Bad event id');

  const existing = await getEvent(id);
  if (!existing) return res.status(404).json({ message: 'Event not found' });

  if (Array.isArray(req.body?.order)) {
    const wanted = req.body.order.map(asInt).filter(Boolean);
    const participants = await listParticipants(id);
    const owned = new Set(participants.map((p) => p.id));

    // A reorder that would add a stranger or drop one of this event's own
    // speakers is refused whole. Applying part of it would leave the queue in an
    // order the admin never asked for.
    if (wanted.length !== participants.length || wanted.some((pid) => !owned.has(pid))) {
      return bad(res, 'That is not a valid order for this event', 409);
    }

    // The (event_id, order_index) unique constraint means a swap cannot be
    // written as two independent updates — the first would collide with the
    // row the second is about to claim. Parking every row on a negative index
    // first frees them all up in one pass, then the final write claims them.
    await Promise.all(participants.map((p) => setParticipantOrder(p.id, -(p.order_index) - 1)));
    await Promise.all(wanted.map((pid, i) => setParticipantOrder(pid, i)));

    return res.json({ message: 'Order saved', participants: await listParticipants(id) });
  }

  const next = await modelNextParticipant(id, { skipRated: req.body?.wrap !== 'queue' });
  return res.json({
    message: next ? `Now on stage: ${next.current_participant_name}` : 'Nobody left in the queue',
    current_participant_id: next?.current_participant_id ?? null,
    current_participant_name: next?.current_participant_name ?? null,
  });
};

/** The results board: one row per speaker with every criterion average. */
export const getResults = async (req, res) => {
  const id = asInt(req.params.id);
  if (!id) return bad(res, 'Bad event id');
  const event = await getEvent(id);
  if (!event) return res.status(404).json({ message: 'Event not found' });

  const [results, voters] = await Promise.all([aggregateResults(id), countVoters(id)]);

  return res.json(
    withServerNow({
      event,
      criteria: criteriaShape(),
      voter_count: voters,
      results: shapeResults(results),
    }),
  );
};