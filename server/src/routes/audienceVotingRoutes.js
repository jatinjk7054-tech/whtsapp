import { Router } from 'express';
import {
  getStatus,
  join,
  rate,
  listAllEvents,
  createNewEvent,
  editEvent,
  removeEvent,
  changeEventStatus,
  listEventParticipants,
  createParticipant,
  editParticipant,
  removeParticipant,
  setCurrent,
  advanceParticipant,
  getResults,
} from '../controllers/audienceVotingController.js';
import { authenticateRole } from '../middleware/authMiddleware.js';

const router = Router();

// ── public: the audience app ────────────────────────────────────────────────
//
// These three endpoints are deliberately unauthenticated. The booth is an open
// link shown on a projector during an event, and every person in the room rates
// from their own phone without an account.
//
// What that costs, stated plainly: anyone who has the URL can rate, the rater
// supplies their own display name, and the device token that stops a double-tap
// is defeated by clearing site storage. That is the intended trade for an event
// booth — the alternative, requiring a CRM login, means most of the room cannot
// participate at all. Do not copy this pattern onto a surface where a vote has
// real consequence.
//
// The database still enforces one rating per participant per voter, so a
// duplicate submission cannot inflate an average.

// Is an event running, and whose turn is it? Polled on a timer by every phone.
router.get('/status', getStatus);

// Register a display name against this device; returns the device token.
router.post('/join', join);

// Record this device's scores for whoever is currently on stage.
router.post('/rate', rate);

// ── admin: the Accounts panel ───────────────────────────────────────────────
//
// Mirrors the donor-management guard in accountsRoutes.js rather than the wider
// HR one in votingRoutes.js: the page lives in the Accounts panel, and that
// panel is already reachable by accounts, admin and super_admin.
const canManage = authenticateRole('accounts', 'admin', 'super_admin');

router.get('/events', canManage, listAllEvents);
router.post('/events', canManage, createNewEvent);
router.put('/events/:id', canManage, editEvent);
router.delete('/events/:id', canManage, removeEvent);

router.get('/events/:id/participants', canManage, listEventParticipants);
router.post('/events/:id/participants', canManage, createParticipant);
router.put('/events/:id/participants/:participantId', canManage, editParticipant);
router.delete('/events/:id/participants/:participantId', canManage, removeParticipant);

// Which speaker is on stage, and the next one.
router.post('/events/:id/current', canManage, setCurrent);
router.post('/events/:id/next', canManage, advanceParticipant);

// Per-criterion averages per speaker.
router.get('/events/:id/results', canManage, getResults);

// One action, three targets, so the router reads as "start / stop / complete"
// rather than three near-identical routes.
//
// Registered LAST on purpose. It is the same shape as /events/:id/participants
// and /events/:id/current — two segments after /events — so registering it first
// would silently swallow them and answer a speaker-add with "Unknown action".
router.post('/events/:id/:action', canManage, changeEventStatus);

export default router;