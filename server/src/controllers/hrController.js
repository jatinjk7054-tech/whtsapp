import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { createHR, getHRByEmail, getHRById, getAllHRs, updateHR } from '../models/hrModel.js';

const generateTempPassword = () => crypto.randomBytes(4).toString('hex');

export const addHR = async (req, res) => {
  try {
    let { ngo_id, name, email, department } = req.body;
    if (!name || !email) {
      return res.status(400).json({ message: 'Name and email are required' });
    }

    if (req.user.role === 'admin') {
      ngo_id = req.user.ngo_id;
    }

    const existing = await getHRByEmail(email);
    if (existing) {
      return res.status(409).json({ message: 'An HR with this email already exists' });
    }

    const tempPassword = generateTempPassword();
    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(tempPassword, salt);

    const hr = await createHR({
      ngo_id: ngo_id || null,
      name,
      email,
      password_hash,
      department: department || null,
      created_by: req.user.id || null,
    });

    const { password_hash: _, ...safeHR } = hr;
    return res.status(201).json({
      message: 'HR created successfully',
      hr: { ...safeHR, generated_password: tempPassword },
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const listHRs = async (req, res) => {
  try {
    const { ngo_id, is_active } = req.query;
    const filters = {};
    if (ngo_id) filters.ngo_id = ngo_id;
    if (is_active !== undefined) filters.is_active = is_active === 'true';

    const hrs = await getAllHRs(filters);
    const safe = hrs.map(({ password_hash, ...rest }) => rest);
    return res.json(safe);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getHR = async (req, res) => {
  try {
    const hr = await getHRById(req.params.id);
    if (!hr) return res.status(404).json({ message: 'HR not found' });
    const { password_hash, ...safe } = hr;
    return res.json(safe);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const editHR = async (req, res) => {
  try {
    const { name, email, department, is_active, password } = req.body;
    const updates = {};
    if (name) updates.name = name;
    if (email) updates.email = email;
    if (department !== undefined) updates.department = department;
    if (is_active !== undefined) updates.is_active = is_active;
    if (password) {
      const salt = await bcrypt.genSalt(10);
      updates.password_hash = await bcrypt.hash(password, salt);
    }
    const hr = await updateHR(req.params.id, updates);
    const { password_hash, ...safe } = hr;
    return res.json({ message: 'HR updated successfully', hr: safe });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
