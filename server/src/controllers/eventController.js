import {
  createEvent,
  getAllEvents,
  getEventById,
  updateEvent,
  deleteEvent,
} from '../models/eventModel.js';

export const addEvent = async (req, res) => {
  try {
    const { title, description, event_date, event_time, location } = req.body;
    if (!title || !event_date) {
      return res.status(400).json({ message: 'Title and event date are required' });
    }
    const event = await createEvent({
      title,
      description,
      event_date,
      event_time: event_time || null,
      location: location || null,
      ngo_id: req.user.ngo_id || req.body.ngo_id || null,
      created_by: req.user.id,
    });
    return res.status(201).json({ message: 'Event created', event });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const listEvents = async (req, res) => {
  try {
    const ngoId = req.user.role === 'super_admin' ? req.query.ngo_id : req.user.ngo_id;
    const events = await getAllEvents(ngoId);
    return res.json(events);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getEvent = async (req, res) => {
  try {
    const event = await getEventById(req.params.id);
    if (!event) return res.status(404).json({ message: 'Event not found' });
    return res.json(event);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const editEvent = async (req, res) => {
  try {
    const { title, description, event_date, event_time, location, is_active } = req.body;
    const updates = {};
    if (title) updates.title = title;
    if (description !== undefined) updates.description = description;
    if (event_date) updates.event_date = event_date;
    if (event_time !== undefined) updates.event_time = event_time;
    if (location !== undefined) updates.location = location;
    if (is_active !== undefined) updates.is_active = is_active;
    const event = await updateEvent(req.params.id, updates);
    return res.json({ message: 'Event updated', event });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const removeEvent = async (req, res) => {
  try {
    const result = await deleteEvent(req.params.id);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
