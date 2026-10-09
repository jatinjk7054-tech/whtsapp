import db from '../config/db.js';

const CONFIG_ROW_ID = 1;

const DEFAULT_CONFIG = {
  api_base_url: 'https://api.beingsevak.org/api',
  socket_url: 'https://api.beingsevak.org',
  minimum_version: '1.0.0',
  update_url: '',
  announcement: null,
  feature_flags: {},
  ui_text: {},
};

const safeParse = (value, fallback) => {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

export const getAppConfig = async () => {
  const { data, error } = await db
    .from('app_config')
    .select('data')
    .eq('id', CONFIG_ROW_ID)
    .single();
  if (error) return { config: { ...DEFAULT_CONFIG }, error: null };
  return {
    config: { ...DEFAULT_CONFIG, ...safeParse(data?.data, {}) },
    error: null,
  };
};

export const updateAppConfig = async (updates) => {
  const { config } = await getAppConfig();
  const next = { ...config, ...updates };
  const { data, error } = await db
    .from('app_config')
    .upsert({ id: CONFIG_ROW_ID, data: next, updated_at: new Date().toISOString() })
    .select('data')
    .single();
  if (error) return { config: null, error };
  return { config: { ...DEFAULT_CONFIG, ...safeParse(data?.data, {}) }, error: null };
};
