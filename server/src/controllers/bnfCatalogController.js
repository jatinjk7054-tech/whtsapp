import {
  listCatalog, createCatalogItem, updateCatalogItem,
} from '../models/bnfCatalogModel.js';

const KINDS = ['kits', 'organizers'];
const SINGULAR = { kits: 'kit', organizers: 'organizer' };

const sanitize = (row) => ({
  id: row?.id,
  name: row?.name || '',
  is_active: row?.is_active !== false,
  created_at: row?.created_at || null,
});

export const listCatalogController = async (req, res) => {
  try {
    const kind = req.params.kind;
    if (!KINDS.includes(kind)) {
      return res.status(404).json({ message: 'Not found' });
    }
    const rows = await listCatalog(kind);
    return res.json({ [kind]: rows.map(sanitize) });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const createCatalogItemController = async (req, res) => {
  try {
    const kind = req.params.kind;
    if (!KINDS.includes(kind)) {
      return res.status(404).json({ message: 'Not found' });
    }
    const name = String(req.body?.name || '').trim();
    if (!name) {
      return res.status(400).json({ message: `${SINGULAR[kind]} name is required` });
    }
    const row = await createCatalogItem(kind, {
      name,
      created_by: req.user?.name || req.user?.email || req.user?.id || null,
    });
    return res.status(201).json({ [SINGULAR[kind]]: sanitize(row), success: true });
  } catch (error) {
    if (error?.code === '23505') {
      return res.status(409).json({ message: `${SINGULAR[kind]} already exists` });
    }
    return res.status(500).json({ message: error.message });
  }
};

export const updateCatalogItemController = async (req, res) => {
  try {
    const kind = req.params.kind;
    if (!KINDS.includes(kind)) {
      return res.status(404).json({ message: 'Not found' });
    }
    const updates = {};
    if (req.body?.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) {
        return res.status(400).json({ message: `${SINGULAR[kind]} name is required` });
      }
      updates.name = name;
    }
    if (req.body?.is_active !== undefined) updates.is_active = !!req.body.is_active;
    if (req.body?.name === undefined && req.body?.is_active === undefined) {
      return res.status(400).json({ message: 'Nothing to update' });
    }
    const row = await updateCatalogItem(kind, req.params.id, updates);
    return res.json({ [SINGULAR[kind]]: sanitize(row), success: true });
  } catch (error) {
    if (error?.code === 'PGRST116') {
      return res.status(404).json({ message: `${SINGULAR[kind]} not found` });
    }
    return res.status(500).json({ message: error.message });
  }
};