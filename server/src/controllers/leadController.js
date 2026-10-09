import {
  createLead,
  getAllLeads,
  getLeadById,
  updateLead,
  deleteLead,
  transferLead,
  getLeadsDashboard,
  ownsLead,
} from '../models/leadModel.js';

// ── Who is allowed to see which lead ─────────────────────────────────────────
// A recruiter only ever sees their own work. Ownership itself lives in the model
// (ownsLead) so the list, the detail view, the aggregates and the tests all agree
// on one definition. HR, admin and super_admin are deliberately unrestricted.
const isRecruiter = (user) => user?.role === 'recruiter';

const isTelecaller = (user) =>
  user?.role === 'telecaller' ||
  (user?.role === 'worker' && (user?.department || '').toLowerCase().trim() === 'fro');

// Roles allowed to ask for the whole pipeline with ?scope=all. The recruiter's
// own panel stays on their slice unless they hold one of these, so the parameter
// can never widen a plain recruiter's access.
const CAN_SCOPE_ALL = new Set(['super_admin', 'admin', 'hr', 'master']);

// The name travels with the id because leads entered before created_by was
// recorded, or moved by hand, carry only a display name.
const owns = (lead, user) => ownsLead(lead, [user.id], user.name);

// The owner filter a recruiter gets, or nothing when they may see everything.
const recruiterOwner = (req) =>
  isRecruiter(req.user) && !(req.query.scope === 'all' && CAN_SCOPE_ALL.has(req.user.role))
    ? { ownerIds: [req.user.id], ownerName: req.user.name }
    : {};

export const addLead = async (req, res) => {
  try {
    const { name, phone, age, source, status, notes, recruiter_id, created_by_name, dob, scheduled_date } = req.body;
    if (!name) {
      return res.status(400).json({ message: 'Lead name is required' });
    }
    const data = {
      name,
      phone: phone || null,
      age: age || null,
      source: source || 'Walk-in',
      status: status,
      notes: notes || null,
      recruiter_id: recruiter_id || null,
      created_by: req.user.id,
      created_by_name: created_by_name || req.user.name || null,
      dob: dob || null,
      scheduled_date: scheduled_date || null,
    };
    if (status === 'scheduled') {
      data.scheduled_by = req.user.id;
      data.scheduled_at = new Date().toISOString();
      data.scheduled_by_name = req.user.name || null;
    }
    const lead = await createLead(data);
    return res.status(201).json({ message: 'Lead created successfully', lead });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const listLeads = async (req, res) => {
  try {
const { recruiter_id, status, search, source } = req.query;
    const filters = { status, search, source };

    if (isRecruiter(req.user)) {
      // recruiter_id / created_by from the query string are ignored on purpose:
      // they used to let a recruiter ask for any colleague's leads by id.
      Object.assign(filters, recruiterOwner(req));
    } else {
      filters.recruiter_id = recruiter_id;
      if (isTelecaller(req.user)) filters.created_by = req.user.id;
    }

    const leads = await getAllLeads(filters);
    return res.json(leads);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getLead = async (req, res) => {
  try {
    const lead = await getLeadById(req.params.id);
    if (!lead) return res.status(404).json({ message: 'Lead not found' });
    if (isRecruiter(req.user) && !owns(lead, req.user)) {
      return res.status(403).json({ message: 'You can only view your own leads' });
    }
    return res.json(lead);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const editLead = async (req, res) => {
  try {
    const existing = await getLeadById(req.params.id);
    if (!existing) return res.status(404).json({ message: 'Lead not found' });

    // A recruiter may edit a lead assigned to them as well as one they entered;
    // telecallers stay on created_by only, which is how they worked before.
    if (isRecruiter(req.user) && !owns(existing, req.user)) {
      return res.status(403).json({ message: 'You can only edit your own leads' });
    }
    if (isTelecaller(req.user) && existing.created_by !== req.user.id) {
      return res.status(403).json({ message: 'You can only edit your own leads' });
    }

    const { name, phone, age, source, status, notes, recruiter_id, dob, scheduled_date } = req.body;
    const updates = {};
    if (name) updates.name = name;
    if (phone !== undefined) updates.phone = phone;
    if (age !== undefined) updates.age = age;
    if (source) updates.source = source;
    if (status) updates.status = status;
    if (notes !== undefined) updates.notes = notes;
    if (recruiter_id !== undefined) updates.recruiter_id = recruiter_id;
    if (dob !== undefined) updates.dob = dob;
    if (scheduled_date !== undefined) updates.scheduled_date = scheduled_date;
    if (status === 'scheduled' && existing.status !== 'scheduled') {
      updates.scheduled_by = req.user.id;
      updates.scheduled_at = new Date().toISOString();
      updates.scheduled_by_name = req.user.name || null;
    }
    const lead = await updateLead(req.params.id, updates);
    return res.json({ message: 'Lead updated successfully', lead });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const removeLead = async (req, res) => {
  try {
    const existing = await getLeadById(req.params.id);
    if (!existing) return res.status(404).json({ message: 'Lead not found' });
    // Deletes are irreversible, so a recruiter is held to the same ownership
    // rule as reads instead of being able to remove anyone's lead by id.
    if (isRecruiter(req.user) && !owns(existing, req.user)) {
      return res.status(403).json({ message: 'You can only delete your own leads' });
    }
    const result = await deleteLead(req.params.id);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const transferLeadOwner = async (req, res) => {
  try {
    const existing = await getLeadById(req.params.id);
    if (!existing) return res.status(404).json({ message: 'Lead not found' });

    if (existing.created_by !== req.user.id) {
      return res.status(403).json({ message: 'You can only transfer leads you own' });
    }

    const { new_owner_id, new_owner_name } = req.body;
    if (!new_owner_id) return res.status(400).json({ message: 'new_owner_id is required' });

    const lead = await transferLead(req.params.id, new_owner_id, new_owner_name || null);
    return res.json({ message: 'Lead transferred successfully', lead });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const dashboard = async (req, res) => {
  try {
    // Aggregates are computed from the same rows the caller may read, so a
    // recruiter's totals can never include a colleague's leads.
    const stats = await getLeadsDashboard(recruiterOwner(req));
    return res.json(stats);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
