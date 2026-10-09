import {
  createAchievement,
  getAllAchievements,
  getAchievementById,
  deleteAchievement,
} from '../models/achievementModel.js';

export const addAchievement = async (req, res) => {
  try {
    const { worker_id, title, description, awarded_date } = req.body;
    if (!worker_id || !title) {
      return res.status(400).json({ message: 'Worker ID and title are required' });
    }
    const achievement = await createAchievement({
      worker_id,
      title,
      description: description || null,
      awarded_date: awarded_date || new Date().toISOString().split('T')[0],
      ngo_id: req.user.ngo_id || req.body.ngo_id || null,
      created_by: req.user.id,
    });
    return res.status(201).json({ message: 'Achievement awarded', achievement });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const listAchievements = async (req, res) => {
  try {
    const ngoId = req.user.role === 'super_admin' ? req.query.ngo_id : req.user.ngo_id;
    const achievements = await getAllAchievements(ngoId);
    return res.json(achievements);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getAchievement = async (req, res) => {
  try {
    const achievement = await getAchievementById(req.params.id);
    if (!achievement) return res.status(404).json({ message: 'Achievement not found' });
    return res.json(achievement);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const removeAchievement = async (req, res) => {
  try {
    const result = await deleteAchievement(req.params.id);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
