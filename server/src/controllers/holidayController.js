import {
  createHoliday,
  getAllHolidays,
  getHolidayById,
  updateHoliday,
  deleteHoliday,
} from '../models/holidayModel.js';

export const addHoliday = async (req, res) => {
  try {
    const { name, date, type, is_recurring } = req.body;
    if (!name || !date) {
      return res.status(400).json({ message: 'Name and date are required' });
    }
    const holiday = await createHoliday({
      name,
      date,
      type: type || 'holiday',
      is_recurring: is_recurring !== undefined ? is_recurring : true,
      ngo_id: req.user.ngo_id || req.body.ngo_id || null,
      created_by: req.user.id,
    });
    return res.status(201).json({ message: 'Holiday created', holiday });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const listHolidays = async (req, res) => {
  try {
    const ngoId = req.user.role === 'super_admin' ? req.query.ngo_id : req.user.ngo_id;
    const holidays = await getAllHolidays(ngoId);
    return res.json(holidays);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getHoliday = async (req, res) => {
  try {
    const holiday = await getHolidayById(req.params.id);
    if (!holiday) return res.status(404).json({ message: 'Holiday not found' });
    return res.json(holiday);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const editHoliday = async (req, res) => {
  try {
    const { name, date, type, is_recurring } = req.body;
    const updates = {};
    if (name) updates.name = name;
    if (date) updates.date = date;
    if (type) updates.type = type;
    if (is_recurring !== undefined) updates.is_recurring = is_recurring;
    const holiday = await updateHoliday(req.params.id, updates);
    return res.json({ message: 'Holiday updated', holiday });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const removeHoliday = async (req, res) => {
  try {
    const result = await deleteHoliday(req.params.id);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
