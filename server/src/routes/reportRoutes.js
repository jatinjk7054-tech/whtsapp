import { Router } from 'express';
import { authenticateRole } from '../middleware/authMiddleware.js';
import db from '../config/db.js';

const router = Router();

const beneficiaryReport = async (req, res) => {
  try {
    const { from_date, to_date, status, category_id, state, city, ngo_id } = req.query;

    // Status breakdown
    const statuses = ['ACTIVE', 'INACTIVE', 'SUSPENDED', 'TRANSFERRED', 'DECEASED', 'DUPLICATE'];
    const statusCounts = {};
    for (const s of statuses) {
      const { count } = await db.from('beneficiaries').select('id', { count: 'exact', head: true }).eq('status', s);
      statusCounts[s] = count || 0;
    }

    // Category breakdown
    const { rows: categoryData } = await db._pool.query(`
      SELECT bc.name, COUNT(bca.beneficiary_id) as count
      FROM beneficiary_categories bc
      LEFT JOIN beneficiary_category_assignments bca ON bc.id = bca.category_id
      GROUP BY bc.id, bc.name
      ORDER BY count DESC
    `);

    // State breakdown
    const { rows: stateData } = await db._pool.query(`
      SELECT COALESCE(state, 'Unknown') as state, COUNT(*) as count
      FROM beneficiaries
      GROUP BY state
      ORDER BY count DESC
    `);

    // Registrations over time (last 12 months)
    const { rows: registrations } = await db._pool.query(`
      SELECT DATE_TRUNC('month', created_at) as month, COUNT(*) as count
      FROM beneficiaries
      WHERE created_at >= NOW() - INTERVAL '12 months'
      GROUP BY DATE_TRUNC('month', created_at)
      ORDER BY month
    `);

    // Fingerprint status
    const { count: fpRegistered } = await db.from('beneficiaries').select('id', { count: 'exact', head: true }).eq('fingerprint_status', 'REGISTERED');
    const { count: fpPending } = await db.from('beneficiaries').select('id', { count: 'exact', head: true }).eq('fingerprint_status', 'NOT_REGISTERED');

    return res.json({
      summary: { total: Object.values(statusCounts).reduce((a, b) => a + b, 0), ...statusCounts },
      by_category: categoryData || [],
      by_state: stateData || [],
      registrations_over_time: registrations || [],
      biometric: { registered: fpRegistered || 0, pending: fpPending || 0 },
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

const programReport = async (req, res) => {
  try {
    const { from_date, to_date, status } = req.query;

    let query = db.from('bnf_programs').select('*, ngos(name, code)', { count: 'exact' });
    if (status) query = query.eq('status', status);
    if (from_date) query = query.gte('program_date', from_date);
    if (to_date) query = query.lte('program_date', to_date);

    const { data: programs, count: totalPrograms } = await query;

    // Total beneficiaries served
    const { count: totalServed } = await db
      .from('program_beneficiaries')
      .select('id', { count: 'exact', head: true })
      .eq('service_status', 'SERVED');

    // Total distributions
    const { count: totalDistributions } = await db
      .from('benefit_distributions')
      .select('id', { count: 'exact', head: true });

    return res.json({
      programs: programs || [],
      summary: {
        total_programs: totalPrograms || 0,
        total_beneficiaries_served: totalServed || 0,
        total_distributions: totalDistributions || 0,
      },
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

const distributionReport = async (req, res) => {
  try {
    const { from_date, to_date, benefit_id, program_id } = req.query;

    let query = db.from('benefit_distributions').select('*, beneficiaries(beneficiary_code, full_name), bnf_programs(title, program_date)', { count: 'exact' });
    if (benefit_id) query = query.eq('benefit_distribution_items.benefit_id', benefit_id);
    if (program_id) query = query.eq('program_id', program_id);
    if (from_date) query = query.gte('distribution_date', from_date);
    if (to_date) query = query.lte('distribution_date', to_date);

    const { data, count } = await query;

    // Per-benefit breakdown
    const { rows: benefitBreakdown } = await db._pool.query(`
      SELECT b.name as benefit_name, b.category, COUNT(bdi.id) as total_distributions, SUM(bdi.quantity) as total_quantity
      FROM benefit_distribution_items bdi
      JOIN benefits b ON bdi.benefit_id = b.id
      JOIN benefit_distributions bd ON bdi.distribution_id = bd.id
      WHERE bd.status = 'COMPLETED'
      GROUP BY b.id, b.name, b.category
      ORDER BY total_distributions DESC
    `);

    return res.json({
      distributions: data || [],
      by_benefit: benefitBreakdown || [],
      summary: {
        total_distributions: count || 0,
        completed: (data || []).filter(d => d.status === 'COMPLETED').length,
        reversed: (data || []).filter(d => d.status === 'REVERSED').length,
      },
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

const volunteerReport = async (req, res) => {
  try {
    const { count: totalVolunteers } = await db.from('bnf_volunteers').select('id', { count: 'exact', head: true });
    const { count: activeVolunteers } = await db.from('bnf_volunteers').select('id', { count: 'exact', head: true }).eq('status', 'ACTIVE');

    const { rows: programParticipation } = await db._pool.query(`
      SELECT bv.full_name, COUNT(pv.program_id) as programs_assigned,
             SUM(CASE WHEN pv.attendance_status = 'PRESENT' THEN 1 ELSE 0 END) as programs_attended
      FROM bnf_volunteers bv
      LEFT JOIN program_volunteers pv ON bv.id = pv.volunteer_id
      WHERE bv.status = 'ACTIVE'
      GROUP BY bv.id, bv.full_name
      ORDER BY programs_assigned DESC
      LIMIT 50
    `);

    return res.json({
      summary: { total: totalVolunteers || 0, active: activeVolunteers || 0 },
      participation: programParticipation || [],
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

router.get('/beneficiaries', authenticateRole('super_admin', 'admin', 'ngo', 'accounts'), beneficiaryReport);
router.get('/programs', authenticateRole('super_admin', 'admin', 'ngo', 'accounts'), programReport);
router.get('/distributions', authenticateRole('super_admin', 'admin', 'ngo', 'accounts'), distributionReport);
router.get('/volunteers', authenticateRole('super_admin', 'admin', 'ngo', 'accounts'), volunteerReport);

export default router;
