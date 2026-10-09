import { Router } from 'express';
import pg from 'pg';
import { authenticate } from '../middleware/authMiddleware.js';

const router = Router();

router.delete('/force/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const poolConfig = {};
    if (process.env.DATABASE_URL) {
      poolConfig.connectionString = process.env.DATABASE_URL;
      poolConfig.ssl = process.env.DATABASE_SSL !== 'false' ? { rejectUnauthorized: false } : false;
    } else {
      poolConfig.host = process.env.PGHOST;
      poolConfig.port = parseInt(process.env.PGPORT || '5432', 10);
      poolConfig.user = process.env.PGUSER;
      poolConfig.password = process.env.PGPASSWORD;
      poolConfig.database = process.env.PGDATABASE;
      if (process.env.PGSSLMODE && process.env.PGSSLMODE !== 'disable') {
        poolConfig.ssl = { rejectUnauthorized: false };
      }
    }
    const client = new pg.Client(poolConfig);
    await client.connect();
    try {
      await client.query('DELETE FROM attendance_corrections WHERE worker_id = $1', [id]);
      await client.query('DELETE FROM attendance WHERE worker_id = $1', [id]);
      await client.query('DELETE FROM leaves WHERE worker_id = $1', [id]);
      await client.query('DELETE FROM worker_loans WHERE worker_id = $1', [id]);
      await client.query('DELETE FROM worker_ngo_allocations WHERE worker_id = $1', [id]);
      await client.query('UPDATE conversations SET assigned_agent_id = NULL WHERE assigned_agent_id = $1', [id]);
      await client.query('DELETE FROM workers WHERE id = $1', [id]);
    } finally {
      await client.end();
    }
    return res.json({ message: 'Worker permanently deleted', id });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

export default router;
