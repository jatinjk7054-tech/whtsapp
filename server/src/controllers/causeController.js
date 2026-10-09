import { createCause, getAllCauses, getCauseById, updateCause, deleteCause } from '../models/causeModel.js';

export const addCause = async (req, res) => {
  try {
    const { ngo_id, name, description, file_url, file_name } = req.body;
    if (!ngo_id || !name) {
      return res.status(400).json({ message: 'NGO and cause name are required' });
    }
    const cause = await createCause({ ngo_id, name, description, file_url, file_name });
    return res.status(201).json({ message: 'Cause created successfully', cause });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const listCauses = async (req, res) => {
  try {
    const { ngo_id } = req.query;
    const causes = await getAllCauses(ngo_id || null);
    return res.json(causes);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getCause = async (req, res) => {
  try {
    const cause = await getCauseById(req.params.id);
    if (!cause) return res.status(404).json({ message: 'Cause not found' });
    return res.json(cause);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const editCause = async (req, res) => {
  try {
    const { name, description, file_url, file_name, is_active } = req.body;
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (file_url !== undefined) updates.file_url = file_url;
    if (file_name !== undefined) updates.file_name = file_name;
    if (is_active !== undefined) updates.is_active = is_active;
    const cause = await updateCause(req.params.id, updates);
    return res.json({ message: 'Cause updated successfully', cause });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const removeCause = async (req, res) => {
  try {
    const result = await deleteCause(req.params.id);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const toggleCause = async (req, res) => {
  try {
    const cause = await getCauseById(req.params.id);
    if (!cause) return res.status(404).json({ message: 'Cause not found' });
    const updated = await updateCause(req.params.id, { is_active: !cause.is_active });
    return res.json({ message: `Cause ${updated.is_active ? 'activated' : 'deactivated'} successfully`, cause: updated });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
