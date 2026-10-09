import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { createUser, getUserByEmail, getUserById, getAllUsers, updateUser } from '../models/userModel.js';
import { getUserNgoAccess as getNgoAccess, setUserNgoAccess as setNgoAccess } from '../models/userNgoAccessModel.js';

const generateTempPassword = () => crypto.randomBytes(4).toString('hex');

async function attachNgoAccess(users) {
  const result = [];
  for (const u of users) {
    const access = await getNgoAccess(u.id);
    result.push({ ...u, ngo_access: access.map(a => a.ngo_id), ngo_names: access.map(a => a.ngo_name).filter(Boolean).join(', ') });
  }
  return result;
}

export const getUserNgoAccessHandler = async (req, res) => {
  try {
    const access = await getNgoAccess(req.params.id);
    return res.json(access);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const setUserNgoAccessHandler = async (req, res) => {
  try {
    const { ngo_ids } = req.body;
    if (!ngo_ids || !Array.isArray(ngo_ids)) {
      return res.status(400).json({ message: 'ngo_ids array is required' });
    }
    const result = await setNgoAccess(req.params.id, ngo_ids);
    return res.json({ message: 'NGO access updated', ngo_access: result.map(r => r.ngo_id) });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const addUser = async (req, res) => {
  try {
    let { ngo_id, ngo_ids, name, email, role, department } = req.body;
    if (!name || !email || !role) {
      return res.status(400).json({ message: 'Name, email, and role are required' });
    }

    // hoadmin (NGO Admin) is global — no NGO binding
    if (role === 'admin') {
      const tempPassword = generateTempPassword();
      const user = await createUser({
        ngo_id: null,
        name, email,
        password_hash: await bcrypt.hash(tempPassword, await bcrypt.genSalt(10)),
        role, department: department || null,
        created_by: req.user.id || null,
      });
      const { password_hash: _, ...safeUser } = user;
      const access = await getNgoAccess(user.id);
      return res.status(201).json({
        message: 'User created successfully',
        user: { ...safeUser, ngo_access: access.map(a => a.ngo_id), generated_password: tempPassword },
      });
    }

    if (req.user.role === 'admin') {
      ngo_id = req.user.ngo_id;
    }

    if (!ngo_id && !ngo_ids && req.user.role !== 'hr') {
      return res.status(400).json({ message: 'NGO is required' });
    }

    const existing = await getUserByEmail(email);
    if (existing) {
      return res.status(409).json({ message: 'A user with this email already exists' });
    }

    const tempPassword = generateTempPassword();
    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(tempPassword, salt);

    const finalNgoId = ngo_ids && ngo_ids.length > 0 ? ngo_ids[0] : ngo_id;

    const user = await createUser({
      ngo_id: finalNgoId,
      name,
      email,
      password_hash,
      role,
      department: department || null,
      created_by: req.user.id || null,
    });

    if (ngo_ids && ngo_ids.length > 0) {
      await setNgoAccess(user.id, ngo_ids);
    } else if (ngo_id) {
      await setNgoAccess(user.id, [ngo_id]);
    }

    const { password_hash: _, ...safeUser } = user;
    const access = await getNgoAccess(user.id);
    return res.status(201).json({
      message: 'User created successfully',
      user: { ...safeUser, ngo_access: access.map(a => a.ngo_id), generated_password: tempPassword },
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const listUsers = async (req, res) => {
  try {
    const { ngo_id, role, is_active } = req.query;
    const filters = {};
    if (ngo_id) filters.ngo_id = ngo_id;
    if (role) filters.role = role;
    if (is_active !== undefined) filters.is_active = is_active === 'true';

    const users = await getAllUsers(filters);
    const safe = users.map(({ password_hash, ...rest }) => rest);
    const enriched = await attachNgoAccess(safe);
    return res.json(enriched);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getUser = async (req, res) => {
  try {
    const user = await getUserById(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    const { password_hash, ...safe } = user;
    const access = await getNgoAccess(user.id);
    return res.json({ ...safe, ngo_access: access.map(a => a.ngo_id) });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const editUser = async (req, res) => {
  try {
    const { name, email, role, department, is_active, password, ngo_ids } = req.body;
    const updates = {};
    if (name) updates.name = name;
    if (email) updates.email = email;
    if (role) updates.role = role;
    if (department !== undefined) updates.department = department;
    if (is_active !== undefined) updates.is_active = is_active;
    if (password) {
      const salt = await bcrypt.genSalt(10);
      updates.password_hash = await bcrypt.hash(password, salt);
    }

    if (ngo_ids !== undefined) {
      const finalNgoId = ngo_ids.length > 0 ? ngo_ids[0] : null;
      updates.ngo_id = finalNgoId;
      await setNgoAccess(req.params.id, ngo_ids);
    }

    const user = await updateUser(req.params.id, updates);
    const { password_hash, ...safe } = user;
    const access = await getNgoAccess(user.id);
    return res.json({ message: 'User updated successfully', user: { ...safe, ngo_access: access.map(a => a.ngo_id) } });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
