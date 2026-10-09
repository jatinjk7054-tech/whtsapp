import { config } from '../config.js';
import { HttpError } from '../lib/HttpError.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { signToken } from '../lib/jwt.js';
import {
  countStaff,
  createStaff,
  getStaffByEmail,
  getStaffById,
  updateStaff,
} from './staff.repository.js';

export async function login({ email, password }) {
  const staff = await getStaffByEmail(email);

  // Same message for unknown email and wrong password so the endpoint cannot
  // be used to enumerate staff accounts.
  if (!staff || !(await verifyPassword(password, staff.password_hash))) {
    throw new HttpError(401, 'Invalid email or password');
  }

  if (!staff.is_active) {
    throw new HttpError(401, 'Account is deactivated');
  }

  const { password_hash: _hash, ...safe } = staff;

  return { token: signToken(safe), staff: safe };
}

export async function registerStaff({ name, email, password, role }) {
  const existing = await getStaffByEmail(email);

  if (existing) throw new HttpError(409, 'A staff member with that email already exists');

  const passwordHash = await hashPassword(password);
  return createStaff({ name, email, passwordHash, role: role ?? 'agent' });
}

export async function adminUpdateStaff(staffId, { name, email, role, isActive, password }) {
  const existing = await getStaffById(staffId);
  if (!existing) throw new HttpError(404, 'Staff member not found');

  if (email !== undefined && email.toLowerCase() !== existing.email.toLowerCase()) {
    const emailOwner = await getStaffByEmail(email);
    if (emailOwner && emailOwner.id !== staffId) {
      throw new HttpError(409, 'A staff member with that email already exists');
    }
  }

  const passwordHash = password !== undefined ? await hashPassword(password) : undefined;
  return updateStaff(staffId, { name, email, role, isActive, passwordHash });
}

export async function changePassword(staffId, { currentPassword, newPassword }) {
  const staff = await getStaffById(staffId);
  if (!staff) throw new HttpError(404, 'Staff member not found');

  const withHash = await getStaffByEmail(staff.email);
  if (!(await verifyPassword(currentPassword, withHash.password_hash))) {
    throw new HttpError(403, 'Current password is incorrect');
  }

  await updateStaff(staffId, { passwordHash: await hashPassword(newPassword) });
  return { changed: true };
}

export async function seedExampleAgents() {
  if (config.env === 'production') return [];

  const examples = config.auth.exampleAgents ?? [];
  const created = [];

  for (const example of examples) {
    if (!example.email || !example.password) continue;
    const existing = await getStaffByEmail(example.email);
    if (existing) continue;

    const passwordHash = await hashPassword(example.password);
    created.push(
      await createStaff({
        name: example.name,
        email: example.email,
        passwordHash,
        role: 'agent',
      })
    );
  }

  if (created.length) {
    console.log(`Seeded ${created.length} example agent account(s). Change their passwords from the admin panel.`);
  }

  return created;
}

export async function seedAdminIfEmpty() {
  if ((await countStaff()) > 0) return null;

  const { email, password, name } = config.auth.seedAdmin;

  if (!email || !password) {
    console.warn('No staff rows and no SEED_ADMIN_* env vars set; skipping admin seed.');
    return null;
  }

  const passwordHash = await hashPassword(password);
  const admin = await createStaff({ name, email, passwordHash, role: 'admin' });

  console.log(`Seeded admin staff account: ${admin.email}`);
  return admin;
}