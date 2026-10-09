import {
  createNotice,
  getAllNotices,
  getNoticeById,
  updateNotice,
  deleteNotice,
  getSeenNoticeIds,
  markNoticeSeen,
} from '../models/noticeModel.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const asUuidOrNull = (v) => (v && UUID_RE.test(String(v))) ? String(v) : null;

export const addNotice = async (req, res) => {
  try {
    const { title, content, target_role, media_url, media_type, media_name, popup, target_roles } = req.body;
    if (!title || !content) {
      return res.status(400).json({ message: 'Title and content are required' });
    }
    const notice = await createNotice({
      title,
      content,
      target_role: target_role || 'all',
      target_roles: Array.isArray(target_roles) && target_roles.length ? target_roles : ['all'],
      popup: typeof popup === 'boolean' ? popup : true,
      media_url: media_url || null,
      media_type: media_type || null,
      media_name: media_name || null,
      ngo_id: req.user.ngo_id || req.body.ngo_id || null,
      created_by: asUuidOrNull(req.user.id),
      created_by_name: req.user.name || null,
    });
    return res.status(201).json({ message: 'Notice created', notice });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const listNotices = async (req, res) => {
  try {
    const ngoId = req.user.role === 'super_admin' ? req.query.ngo_id : req.user.ngo_id;
    const notices = await getAllNotices(ngoId, req.query.target_role, req.user);
    const seen = await getSeenNoticeIds(req.user.id);
    const out = (notices || []).map(n => ({ ...n, seen: seen.has(String(n.id)) }));
    return res.json(out);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const markSeen = async (req, res) => {
  try {
    await markNoticeSeen(req.user.id, req.params.id);
    return res.json({ seen: true });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getNotice = async (req, res) => {
  try {
    const notice = await getNoticeById(req.params.id);
    if (!notice) return res.status(404).json({ message: 'Notice not found' });
    return res.json(notice);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const editNotice = async (req, res) => {
  try {
    const { title, content, is_active, media_url, media_type, media_name, popup, target_roles } = req.body;
    const updates = {};
    if (title !== undefined) updates.title = title;
    if (content !== undefined) updates.content = content;
    if (is_active !== undefined) updates.is_active = is_active;
    if (media_url !== undefined) updates.media_url = media_url || null;
    if (media_type !== undefined) updates.media_type = media_type || null;
    if (media_name !== undefined) updates.media_name = media_name || null;
    if (popup !== undefined) updates.popup = popup === true;
    if (target_roles !== undefined) updates.target_roles = Array.isArray(target_roles) && target_roles.length ? target_roles : ['all'];
    const notice = await updateNotice(req.params.id, updates);
    return res.json({ message: 'Notice updated', notice });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const removeNotice = async (req, res) => {
  try {
    const result = await deleteNotice(req.params.id);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
