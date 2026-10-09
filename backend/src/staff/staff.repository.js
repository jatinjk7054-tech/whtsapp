import { query } from '../db/pool.js';

const PUBLIC_COLUMNS = `id, name, email, role, is_active, created_at, updated_at`;

export async function getStaffById(id) {
  const result = await query(`SELECT ${PUBLIC_COLUMNS} FROM staff WHERE id = $1`, [id]);
  return result.rows[0] ?? null;
}

export async function getStaffByEmail(email) {
  const result = await query(
    `SELECT id, name, email, role, is_active, password_hash, created_at, updated_at
     FROM staff WHERE LOWER(email) = LOWER($1)`,
    [email]
  );
  return result.rows[0] ?? null;
}

export async function listStaff({ includeInactive = false } = {}) {
  const result = await query(
    `SELECT ${PUBLIC_COLUMNS} FROM staff
     ${includeInactive ? '' : 'WHERE is_active = TRUE'}
     ORDER BY name ASC`
  );
  return result.rows;
}

export async function createStaff({ name, email, passwordHash, role = 'agent' }) {
  const result = await query(
    `INSERT INTO staff (name, email, password_hash, role)
     VALUES ($1, $2, $3, $4)
     RETURNING ${PUBLIC_COLUMNS}`,
    [name, email, passwordHash, role]
  );
  return result.rows[0];
}

export async function updateStaff(id, { name, email, role, isActive, passwordHash }) {
  const fields = [];
  const values = [id];

  if (name !== undefined) {
    values.push(name);
    fields.push(`name = $${values.length}`);
  }
  if (email !== undefined) {
    values.push(email);
    fields.push(`email = $${values.length}`);
  }
  if (role !== undefined) {
    values.push(role);
    fields.push(`role = $${values.length}`);
  }
  if (isActive !== undefined) {
    values.push(isActive);
    fields.push(`is_active = $${values.length}`);
  }
  if (passwordHash !== undefined) {
    values.push(passwordHash);
    fields.push(`password_hash = $${values.length}`);
  }

  if (fields.length === 0) return getStaffById(id);

  values.push(new Date());
  fields.push(`updated_at = $${values.length}`);

  const result = await query(
    `UPDATE staff SET ${fields.join(', ')} WHERE id = $1 RETURNING ${PUBLIC_COLUMNS}`,
    values
  );
  return result.rows[0] ?? null;
}

export async function countStaff() {
  const result = await query('SELECT COUNT(*)::int AS total FROM staff');
  return result.rows[0].total;
}

/**
 * A small, deliberately assignment-free workload report: how many live
 * conversations each agent currently carries.
 */
export async function listAssignmentLoad() {
  const result = await query(
    `SELECT s.id, s.name, s.role, s.is_active,
            COUNT(c.id)::int AS open_count,
            COUNT(c.id) FILTER (WHERE c.status = 'pending')::int AS pending_count
     FROM staff s
     LEFT JOIN conversations c
       ON c.assigned_staff_id = s.id AND c.status <> 'closed'
     WHERE s.is_active = TRUE
     GROUP BY s.id
     ORDER BY open_count DESC, s.name ASC`
  );
  return result.rows;
}