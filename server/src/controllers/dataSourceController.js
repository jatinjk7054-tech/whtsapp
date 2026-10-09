import { createDataSource, getAllDataSources, getDataSourceById, updateDataSource, deleteDataSource } from '../models/dataSourceModel.js';

export const addDataSource = async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) {
      return res.status(400).json({ message: 'Data source name is required' });
    }
    const ds = await createDataSource({ name });
    return res.status(201).json({ message: 'Data source created successfully', dataSource: ds });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const listDataSources = async (req, res) => {
  try {
    const sources = await getAllDataSources();
    return res.json(sources);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getDataSource = async (req, res) => {
  try {
    const ds = await getDataSourceById(req.params.id);
    if (!ds) return res.status(404).json({ message: 'Data source not found' });
    return res.json(ds);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const editDataSource = async (req, res) => {
  try {
    const { name, is_active } = req.body;
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (is_active !== undefined) updates.is_active = is_active;
    const ds = await updateDataSource(req.params.id, updates);
    return res.json({ message: 'Data source updated successfully', dataSource: ds });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const removeDataSource = async (req, res) => {
  try {
    const result = await deleteDataSource(req.params.id);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const toggleDataSource = async (req, res) => {
  try {
    const ds = await getDataSourceById(req.params.id);
    if (!ds) return res.status(404).json({ message: 'Data source not found' });
    const updated = await updateDataSource(req.params.id, { is_active: !ds.is_active });
    return res.json({ message: `Data source ${updated.is_active ? 'activated' : 'deactivated'} successfully`, dataSource: updated });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
