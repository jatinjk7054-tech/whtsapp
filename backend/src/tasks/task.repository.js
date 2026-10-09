import { query } from '../db/pool.js';

const SORTS = {
  created_desc: 'created_at DESC',
  created_asc: 'created_at ASC',
  title_asc: 'title ASC',
};

export async function listTasks({ completed, sort = 'created_desc', limit = 50, offset = 0 }) {
  const conditions = [];
  const values = [];

  if (completed !== undefined) {
    values.push(completed);
    conditions.push(`completed = $${values.length}`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const orderBy = SORTS[sort] ?? SORTS.created_desc;

  values.push(limit, offset);

  const result = await query(
    `SELECT id, title, description, completed, created_at, updated_at
     FROM tasks
     ${where}
     ORDER BY ${orderBy}
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values
  );

  const countResult = await query(
    `SELECT COUNT(*)::int AS total FROM tasks ${where}`,
    values.slice(0, values.length - 2)
  );

  return { items: result.rows, total: countResult.rows[0].total };
}

export async function getTask(id) {
  const result = await query(
    `SELECT id, title, description, completed, created_at, updated_at
     FROM tasks WHERE id = $1`,
    [id]
  );
  return result.rows[0] ?? null;
}

export async function createTask({ title, description = '', completed = false }) {
  const result = await query(
    `INSERT INTO tasks (title, description, completed)
     VALUES ($1, $2, $3)
     RETURNING id, title, description, completed, created_at, updated_at`,
    [title, description, completed]
  );
  return result.rows[0];
}

export async function updateTask(id, { title, description, completed }) {
  const fields = [];
  const values = [id];

  if (title !== undefined) {
    values.push(title);
    fields.push(`title = $${values.length}`);
  }
  if (description !== undefined) {
    values.push(description);
    fields.push(`description = $${values.length}`);
  }
  if (completed !== undefined) {
    values.push(completed);
    fields.push(`completed = $${values.length}`);
  }

  if (fields.length === 0) return getTask(id);

  values.push(new Date());
  fields.push(`updated_at = $${values.length}`);

  const result = await query(
    `UPDATE tasks SET ${fields.join(', ')} WHERE id = $1
     RETURNING id, title, description, completed, created_at, updated_at`,
    values
  );
  return result.rows[0] ?? null;
}

export async function deleteTask(id) {
  const result = await query('DELETE FROM tasks WHERE id = $1 RETURNING id', [id]);
  return result.rowCount > 0;
}