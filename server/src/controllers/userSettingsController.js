import { getAllUserSettings, upsertUserSetting } from '../models/userSettingsModel.js';
import { upsertSetting } from '../models/settingsModel.js';

const SYNC_KEY_MAP = {
  razorpaySync: 'razorpay_sync_enabled',
  emailImport: 'email_import_enabled',
};

export const getUserSettings = async (req, res) => {
  try {
    const settings = await getAllUserSettings(req.user.id);
    return res.json(settings);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const updateUserSettings = async (req, res) => {
  try {
    const updates = req.body;
    for (const [key, value] of Object.entries(updates)) {
      await upsertUserSetting(req.user.id, key, String(value));
      const systemKey = SYNC_KEY_MAP[key];
      if (systemKey) {
        await upsertSetting(systemKey, String(value));
      }
    }
    const settings = await getAllUserSettings(req.user.id);
    return res.json({ message: 'Settings updated', settings });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
