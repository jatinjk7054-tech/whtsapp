import db from '../config/db.js';

export const generateDistributionNumber = async () => {
  const { count } = await db.from('benefit_distributions').select('id', { count: 'exact', head: true });
  return `DIST-${String((count || 0) + 1).padStart(6, '0')}`;
};

export const createDistribution = async (data) => {
  const { data: result, error } = await db
    .from('benefit_distributions')
    .insert(data)
    .select('*')
    .single();
  if (error) throw error;
  return result;
};

export const addDistributionItem = async (data) => {
  const { data: result, error } = await db
    .from('benefit_distribution_items')
    .insert(data)
    .select('*')
    .single();
  if (error) throw error;
  return result;
};

const getDistributionItems = async (distributionId) => {
  const { data, error } = await db
    .from('benefit_distribution_items')
    .select('*, benefits(name, category)')
    .eq('distribution_id', distributionId);
  if (error) throw error;
  return data || [];
};

export const getDistributionById = async (id) => {
  const { data, error } = await db
    .from('benefit_distributions')
    .select('*, beneficiaries(id, beneficiary_code, full_name, mobile), bnf_programs(id, title, program_date)')
    .eq('id', id)
    .single();
  if (error) return null;
  data.benefit_distribution_items = await getDistributionItems(data.id);
  return data;
};

export const listDistributions = async ({ page = 1, pageSize = 25, beneficiary_id, program_id, benefit_id, from_date, to_date, status }) => {
  let query = db.from('benefit_distributions').select('*, beneficiaries(id, beneficiary_code, full_name), bnf_programs(id, title)', { count: 'exact' });

  if (beneficiary_id) query = query.eq('beneficiary_id', beneficiary_id);
  if (program_id) query = query.eq('program_id', program_id);
  if (status) query = query.eq('status', status);
  if (from_date) query = query.gte('distribution_date', from_date);
  if (to_date) query = query.lte('distribution_date', to_date);

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  query = query.order('distribution_date', { ascending: false }).range(from, to);

  const { data, error, count } = await query;
  if (error) throw error;
  return { data: data || [], total: count || 0, page, pageSize };
};

export const reverseDistribution = async (distributionId, reason) => {
  const { data: existing } = await db
    .from('benefit_distributions')
    .select('*')
    .eq('id', distributionId)
    .single();

  if (!existing) throw new Error('Distribution not found');
  if (existing.status === 'REVERSED') throw new Error('Distribution already reversed');

  const { data, error } = await db
    .from('benefit_distributions')
    .update({ status: 'REVERSED', remarks: reason || 'Reversed' })
    .eq('id', distributionId)
    .select('*')
    .single();
  if (error) throw error;
  return data;
};

export const getBeneficiaryDistributionHistory = async (beneficiaryId) => {
  const { data, error } = await db
    .from('benefit_distributions')
    .select('*, bnf_programs(id, title, program_date)')
    .eq('beneficiary_id', beneficiaryId)
    .order('distribution_date', { ascending: false });
  if (error) throw error;

  const distributions = data || [];
  for (const d of distributions) {
    d.benefit_distribution_items = await getDistributionItems(d.id);
  }
  return distributions;
};
