import { getAppConfig, updateAppConfig } from '../models/configModel.js';

export const getPublicConfig = async (req, res) => {
  try {
    const { config, error } = await getAppConfig();
    if (error) return res.status(500).json({ message: error.message });
    res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    return res.json(config);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getAdminConfig = async (req, res) => {
  try {
    const { config, error } = await getAppConfig();
    if (error) return res.status(500).json({ message: error.message });
    return res.json(config);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const updateConfig = async (req, res) => {
  try {
    const updates = req.body;
    if (updates === null || typeof updates !== 'object' || Array.isArray(updates)) {
      return res.status(400).json({ message: 'Body must be a JSON object of config keys' });
    }
    const { config, error } = await updateAppConfig(updates);
    if (error) return res.status(500).json({ message: error.message });
    return res.json({ message: 'Config updated', config });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
