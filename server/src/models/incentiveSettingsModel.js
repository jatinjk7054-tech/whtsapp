import db from '../config/db.js';

export const getSettings = async () => {
  const { data, error } = await db
    .from('incentive_settings')
    .select('*');
  if (error) throw error;
  const map = {};
  for (const row of data || []) {
    map[row.setting_key] = Number(row.setting_value);
  }
  return {
    lead_rate: map.lead_rate ?? 20,
    min_lead_amount: map.min_lead_amount ?? 300,
    champion_bonus: map.champion_bonus ?? 250,
  };
};

export const updateSettings = async ({ lead_rate, min_lead_amount, champion_bonus }) => {
  const updates = [];
  if (lead_rate !== undefined) updates.push({ setting_key: 'lead_rate', setting_value: lead_rate });
  if (min_lead_amount !== undefined) updates.push({ setting_key: 'min_lead_amount', setting_value: min_lead_amount });
  if (champion_bonus !== undefined) updates.push({ setting_key: 'champion_bonus', setting_value: champion_bonus });

  for (const u of updates) {
    const { error } = await db
      .from('incentive_settings')
      .update({ setting_value: u.setting_value, updated_at: new Date().toISOString() })
      .eq('setting_key', u.setting_key);
    if (error) throw error;
  }
  return getSettings();
};
