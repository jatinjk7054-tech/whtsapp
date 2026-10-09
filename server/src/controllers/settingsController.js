import { getAllSettings, upsertSetting } from '../models/settingsModel.js';

export const getSettings = async (req, res) => {
  try {
    const settings = await getAllSettings();
    return res.json(settings);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const updateSettings = async (req, res) => {
  try {
    const updates = req.body;
    for (const [key, value] of Object.entries(updates)) {
      await upsertSetting(key, String(value));
    }
    const settings = await getAllSettings();
    return res.json({ message: 'Settings updated', settings });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
