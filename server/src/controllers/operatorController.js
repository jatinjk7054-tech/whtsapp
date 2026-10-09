import {
  createOperatorEvent, updateOperatorEvent, getOperatorEventById,
  listOperatorEvents, deleteOperatorEvent, assignOperatorEvent,
  getOperatorAssignmentsByDate, getTodayAssignment, upsertSelfAssignment,
  attachProgramsToEvent, listEventPrograms, removeEventProgram,
  listEventMarkedBeneficiaries, demoOperatorEvent, getKitsDashboard,
} from '../models/operatorModel.js';
import { listCatalog } from '../models/bnfCatalogModel.js';
import { getBnfOperatorBySession } from '../models/bnfOperatorModel.js';
import db from '../config/db.js';

const NORMALIZED_DATE = () => new Date().toISOString().split('T')[0];

const SELFIE_BUCKET = 'worker-documents';

const ensureSelfieBucket = async () => {
  const { data: buckets } = await db.storage.listBuckets();
  const exists = buckets?.some((b) => b.name === SELFIE_BUCKET);
  if (!exists) {
    await db.storage.createBucket(SELFIE_BUCKET, { public: true });
  }
};

export const addOperatorEvent = async (req, res) => {
  try {
    const { title, description, event_date, start_time, end_time, location, state, selfie_url } = req.body;
    if (!title || !event_date) {
      return res.status(400).json({ message: 'Title and event date are required' });
    }
    const event = await createOperatorEvent({
      title,
      description,
      event_date,
      start_time: start_time || null,
      end_time: end_time || null,
      location: location || null,
      state: state || null,
      selfie_url: selfie_url || null,
      created_by: req.user?.name || req.user?.email || 'system',
    });
    return res.status(201).json({ message: 'Event created', event });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const editOperatorEvent = async (req, res) => {
  try {
    const { title, description, event_date, start_time, end_time, location, state, selfie_url } = req.body;
    const updates = {};
    if (title) updates.title = title;
    if (description !== undefined) updates.description = description;
    if (event_date) updates.event_date = event_date;
    if (start_time !== undefined) updates.start_time = start_time;
    if (end_time !== undefined) updates.end_time = end_time;
    if (location !== undefined) updates.location = location;
    if (state !== undefined) updates.state = state;
    if (selfie_url !== undefined) updates.selfie_url = selfie_url;
    const event = await updateOperatorEvent(req.params.id, updates);
    return res.json({ message: 'Event updated', event });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getOperatorEvent = async (req, res) => {
  try {
    const event = await getOperatorEventById(req.params.id);
    if (!event) return res.status(404).json({ message: 'Event not found' });
    return res.json(event);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const listOperatorEventsController = async (req, res) => {
  try {
    const { date, state } = req.query;
    const events = await listOperatorEvents({ date, state });
    return res.json(events);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const removeOperatorEvent = async (req, res) => {
  try {
    const result = await deleteOperatorEvent(req.params.id);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const assignEvent = async (req, res) => {
  try {
    const { operator_id, state, event_id, assignment_date } = req.body;
    if (!operator_id || !event_id || !assignment_date) {
      return res.status(400).json({ message: 'operator_id, event_id and assignment_date are required' });
    }
    const event = await getOperatorEventById(event_id);
    if (!event) return res.status(404).json({ message: 'Event not found' });
    const assignment = await assignOperatorEvent({
      operator_id,
      state: state || event.state || null,
      event_id,
      assignment_date,
    });
    return res.status(201).json({ message: 'Assignment created', assignment });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const operatorDashboard = async (req, res) => {
  try {
    const worker = await getBnfOperatorBySession(req.user);
    if (!worker) return res.status(404).json({ message: 'Operator not found' });

    const today = NORMALIZED_DATE();
    let state = null;
    let city = null;
    let event = null;
    let selfie = null;
    let kitId = null;
    let organizerId = null;

    const assignment = await getTodayAssignment(worker.id, today);
    if (assignment) {
      state = assignment.state || null;
      city = assignment.city || null;
      selfie = assignment.selfie_url || assignment.operator_events?.selfie_url || null;
      event = assignment.operator_events || null;
      kitId = assignment.kit_id || null;
      organizerId = assignment.organizer_id || null;
    }

    // Events available for today (dropdown source). Fall back to a demo event
    // so the operator always has something to pick while testing.
    let events = await listOperatorEvents({ date: today });
    if (!events || events.length === 0) {
      events = [demoOperatorEvent];
    }

    // Kit + organizer catalogs (dropdown sources). Only active entries are
    // selectable; previously-picked inactive ones are still shown so the
    // operator can see their saved assignment.
    const [kits, organizers] = await Promise.all([
      listCatalog('kits'),
      listCatalog('organizers'),
    ]);

    return res.json({
      operator: { id: worker.id, name: worker.name, login_id: worker.login_id, role: req.user.role },
      state,
      city,
      event,
      selfie,
      selfie_url: selfie,
      has_event: !!event,
      events,
      kit_id: kitId,
      organizer_id: organizerId,
      kits,
      organizers,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Worker saves their own day's assignment (state/city/event/kit/organizer/selfie).
export const saveSelfAssignment = async (req, res) => {
  try {
    const worker = await getBnfOperatorBySession(req.user);
    if (!worker) return res.status(404).json({ message: 'Operator not found' });

    const { state, city, event_id, selfie_url, kit_id, organizer_id } = req.body;
    const assignmentDate = req.body.assignment_date || NORMALIZED_DATE();

    const assignment = await upsertSelfAssignment(worker.id, {
      state,
      city,
      event_id: event_id ? parseInt(event_id) : null,
      assignment_date: assignmentDate,
      selfie_url,
      kit_id: kit_id ? parseInt(kit_id) : null,
      organizer_id: organizer_id ? parseInt(organizer_id) : null,
    });

    return res.json({ message: 'Assignment saved', assignment });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Upload a base64 selfie to storage and return its public URL.
export const uploadOperatorSelfie = async (req, res) => {
  try {
    const { selfie_base64, mime_type } = req.body;
    if (!selfie_base64) {
      return res.status(400).json({ message: 'selfie_base64 is required' });
    }
    const worker = await getBnfOperatorBySession(req.user);
    const workerId = worker?.id ?? req.user.id;

    await ensureSelfieBucket();
    const buffer = Buffer.from(selfie_base64, 'base64');
    const contentType = mime_type || 'image/jpeg';
    const ext = contentType.split('/')[1] || 'jpg';
    const fileName = `operator-selfies/${workerId}_${Date.now()}.${ext}`;

    const { error: uploadError } = await db.storage
      .from(SELFIE_BUCKET)
      .upload(fileName, buffer, { contentType, upsert: true });
    if (uploadError) {
      return res.status(500).json({ message: 'Upload failed: ' + uploadError.message });
    }

    const { data: publicUrlData } = db.storage
      .from(SELFIE_BUCKET)
      .getPublicUrl(fileName);
    const selfieUrl = publicUrlData?.publicUrl;

    return res.json({ selfie_url: selfieUrl });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const listOperatorDayAssignments = async (req, res) => {
  try {
    const { date } = req.query;
    const worker = await getBnfOperatorBySession(req.user);
    if (!worker) return res.status(404).json({ message: 'Operator not found' });
    const day = date || NORMALIZED_DATE();
    const assignments = await getOperatorAssignmentsByDate(worker.id, day);
    return res.json(assignments);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const listEventProgramsController = async (req, res) => {
  try {
    const eventId = parseInt(req.params.id, 10);
    if (!Number.isInteger(eventId)) {
      return res.status(400).json({ message: 'Invalid event id' });
    }
    const programs = await listEventPrograms(eventId);
    return res.json(programs);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const attachEventPrograms = async (req, res) => {
  try {
    const eventId = parseInt(req.params.id, 10);
    if (!Number.isInteger(eventId)) {
      return res.status(400).json({ message: 'Invalid event id' });
    }
    const event = await getOperatorEventById(eventId);
    if (!event) return res.status(404).json({ message: 'Event not found' });

    const { program_ids } = req.body || {};
    if (!Array.isArray(program_ids) || program_ids.length === 0) {
      return res.status(400).json({ message: 'program_ids is required' });
    }
    await attachProgramsToEvent(eventId, program_ids, req.user?.name || req.user?.email || 'system');
    const programs = await listEventPrograms(eventId);
    return res.status(201).json({ message: 'Programs attached to event', programs });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const detachEventProgram = async (req, res) => {
  try {
    const eventId = parseInt(req.params.id, 10);
    const programId = parseInt(req.params.programId, 10);
    if (!Number.isInteger(eventId) || !Number.isInteger(programId)) {
      return res.status(400).json({ message: 'Invalid event or program id' });
    }
    const result = await removeEventProgram(eventId, programId);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Beneficiaries marked (kit given) under an event — used by the admin panel
// and the operator app's Event screen.
export const listEventBeneficiariesController = async (req, res) => {
  try {
    const eventId = parseInt(req.params.id, 10);
    if (!Number.isInteger(eventId)) {
      return res.status(400).json({ message: 'Invalid event id' });
    }
    const beneficiaries = await listEventMarkedBeneficiaries(eventId);
    return res.json(beneficiaries);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Kits screen for the beneficiaries app: BSCT/AFLF/MANN registration +
// kit-given counts, today's event, and the latest kit handouts.
export const getKitsController = async (req, res) => {
  try {
    const worker = await getBnfOperatorBySession(req.user);
    const data = await getKitsDashboard({
      operatorId: worker?.id || null,
      date: NORMALIZED_DATE(),
    });
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};