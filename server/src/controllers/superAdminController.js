import db from '../config/db.js';
import { getUserNgoAccess } from '../models/userNgoAccessModel.js';

export const getNgoAdminTargets = async (req, res) => {
  try {
    const { data: admins, error } = await db
      .from('workers')
      .select('id, name, login_id, daily_collection_target')
      .ilike('department', '%ngo admin%');

    if (error) return res.status(500).json({ message: error.message });

    const today = new Date().toISOString().slice(0, 10);

    const result = await Promise.all((admins || []).map(async (admin) => {
      const access = await getUserNgoAccess(admin.id);
      const ngoIds = access.map(a => a.ngo_id).filter(Boolean);

      let todayCollection = 0;

      if (ngoIds.length > 0) {
        const { data: donors } = await db
          .from('donor_profiles')
          .select('id')
          .in('ngo_id', ngoIds);

        if (donors && donors.length > 0) {
          const donorIds = donors.map(d => d.id);
          const { data: assignments } = await db
            .from('fro_assignments')
            .select('id')
            .in('donor_id', donorIds);

          if (assignments && assignments.length > 0) {
            const assignmentIds = assignments.map(a => a.id);
            const { data: logs } = await db
              .from('fro_donor_logs')
              .select('amount_collected, verified_at, created_at')
              .in('assignment_id', assignmentIds)
              .eq('disposition_detail', 'lead_done')
              .eq('accounts_status', 'verified')
              .gte('verified_at', today);

            for (const log of (logs || [])) {
              const verifiedDate = (log.verified_at || log.created_at || '').slice(0, 10);
              if (verifiedDate === today) {
                todayCollection += Number(log.amount_collected || 0);
              }
            }
          }
        }
      }

      return {
        id: admin.id,
        name: admin.name,
        login_id: admin.login_id,
        daily_target: Number(admin.daily_collection_target) || 0,
        today_collection: todayCollection,
        ngo_count: ngoIds.length,
      };
    }));

    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const setNgoAdminTarget = async (req, res) => {
  try {
    const { workerId } = req.params;
    const { daily_target } = req.body;

    if (daily_target == null || daily_target < 0) {
      return res.status(400).json({ message: 'daily_target must be a positive number' });
    }

    const { error } = await db
      .from('workers')
      .update({ daily_collection_target: daily_target })
      .eq('id', workerId);

    if (error) return res.status(500).json({ message: error.message });

    return res.json({ message: 'Daily target updated', daily_target });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};


