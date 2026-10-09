import bcrypt from 'bcryptjs';
import {
  createBnfOperator,
  getBnfOperatorById,
  getBnfOperatorByLoginId,
  listBnfOperators,
  updateBnfOperator,
} from '../models/bnfOperatorModel.js';

// Operators of the Beneficiaries mobile app, stored in their own
// bnf_operators table (NOT the workers table). Only these accounts pass the
// app login gate (/auth/worker/login with client = 'beneficiaries').

function normalizeName(name) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '');
}

// Operator login ids look like op.firstname.lastname so they never collide
// with HR/attendance worker accounts.
async function nextLoginId(name) {
  const base = `op.${normalizeName(name) || 'operator'}`;
  let candidate = base;
  let counter = 2;
  while (true) {
    const existing = await getBnfOperatorByLoginId(candidate);
    if (!existing) return candidate;
    candidate = `${base}${counter}`;
    counter++;
  }
}

const sanitize = (w) => ({
  id: w?.id,
  name: w?.name || '',
  email: w?.email || null,
  phone: w?.phone || null,
  login_id: w?.login_id || '',
  is_active: w?.is_active !== false,
  created_at: w?.created_at || null,
});

export const listBnfOperatorsController = async (req, res) => {
  try {
    const operators = await listBnfOperators();
    return res.json({ operators: operators.map(sanitize) });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const createBnfOperatorController = async (req, res) => {
  try {
    const { name, email, phone, password } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ message: 'Operator name is required' });
    }

    const login_id = await nextLoginId(String(name).trim());
    // Default password follows the org convention `<name>.jod` (normalized
    // same way as the login id), e.g. 'Riya Sharma' → 'riya.sharma.jod'.
    const plainPassword = password ? String(password) : `${normalizeName(String(name).trim())}.jod`;
    const salt = await bcrypt.genSalt(10);
    const hashed = await bcrypt.hash(plainPassword, salt);

    const operator = await createBnfOperator({
      name: String(name).trim(),
      email: email || null,
      phone: phone || null,
      login_id,
      password: hashed,
      is_active: true,
      created_by: req.user?.id || req.user?.name || null,
    });

    return res.status(201).json({
      message: 'Operator created successfully',
      operator: sanitize(operator),
      login_id,
      password: plainPassword,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const updateBnfOperatorController = async (req, res) => {
  try {
    const operator = await getBnfOperatorById(String(req.params.id || '').trim());
    if (!operator) {
      return res.status(404).json({ message: 'Operator not found' });
    }

    const updates = {};
    if (req.body?.name) updates.name = String(req.body.name).trim();
    if (req.body?.email !== undefined) updates.email = req.body.email || null;
    if (req.body?.phone !== undefined) updates.phone = req.body.phone || null;
    if (req.body?.is_active !== undefined) updates.is_active = !!req.body.is_active;
    if (req.body?.password) {
      const salt = await bcrypt.genSalt(10);
      updates.password = await bcrypt.hash(String(req.body.password), salt);
    }

    const updated = await updateBnfOperator(operator.id, updates);
    return res.json({ message: 'Operator updated successfully', operator: sanitize(updated) });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};