import db from '../config/db.js';

export const createBenefit = async (data) => {
  const { data: result, error } = await db
    .from('benefits')
    .insert(data)
    .select('*')
    .single();
  if (error) throw error;
  return result;
};

export const listBenefits = async () => {
  const { data, error } = await db
    .from('benefits')
    .select('*')
    .order('name');
  if (error) throw error;
  return data || [];
};

export const getBenefitById = async (id) => {
  const { data, error } = await db
    .from('benefits')
    .select('*')
    .eq('id', id)
    .single();
  if (error) return null;
  return data;
};

export const updateBenefit = async (id, updates) => {
  updates.updated_at = new Date().toISOString();
  const { data, error } = await db
    .from('benefits')
    .update(updates)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data;
};

export const setEligibilityRules = async (benefitId, rules) => {
  // Remove existing rules
  await db.from('benefit_eligibility_rules').delete().eq('beneficiary_id', benefitId);

  if (!rules || rules.length === 0) return [];

  const rows = rules.map(rule => ({
    benefit_id: benefitId,
    rule_type: rule.rule_type,
    rule_value: rule.rule_value,
    category_id: rule.category_id || null,
    active: rule.active !== false,
  }));

  const { data, error } = await db
    .from('benefit_eligibility_rules')
    .insert(rows)
    .select('*');
  if (error) throw error;
  return data || [];
};

export const getEligibilityRules = async (benefitId) => {
  const { data, error } = await db
    .from('benefit_eligibility_rules')
    .select('*, beneficiary_categories(id, name)')
    .eq('benefit_id', benefitId);
  if (error) throw error;
  return data || [];
};

export const checkEligibility = async (beneficiaryId, benefitId) => {
  // Get eligibility rules for the benefit
  const { data: rules } = await db
    .from('benefit_eligibility_rules')
    .select('*')
    .eq('benefit_id', benefitId)
    .eq('active', true);

  if (!rules || rules.length === 0) return { eligible: true, reason: 'No rules configured' };

  for (const rule of rules) {
    if (rule.rule_type === 'COOLDOWN_DAYS') {
      const cooldownDays = parseInt(rule.rule_value);
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - cooldownDays);

      const { count } = await db
        .from('benefit_distributions')
        .select('id', { count: 'exact', head: true })
        .eq('beneficiary_id', beneficiaryId)
        .gte('distribution_date', cutoffDate.toISOString());

      if (count > 0) {
        return { eligible: false, reason: `Cooldown period: ${cooldownDays} days since last distribution` };
      }
    }

    if (rule.rule_type === 'MAX_PER_YEAR') {
      const maxPerYear = parseInt(rule.rule_value);
      const yearStart = new Date(new Date().getFullYear(), 0, 1).toISOString();

      const { count } = await db
        .from('benefit_distributions')
        .select('id', { count: 'exact', head: true })
        .eq('beneficiary_id', beneficiaryId)
        .gte('distribution_date', yearStart);

      if (count >= maxPerYear) {
        return { eligible: false, reason: `Maximum ${maxPerYear} distributions per year reached` };
      }
    }
  }

  return { eligible: true, reason: 'Eligible' };
};
