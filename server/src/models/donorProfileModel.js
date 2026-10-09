import db from '../config/db.js';

export const getDonorByMobile = async (mobile) => {
  const { data, error } = await db
    .from('donor_profiles')
    .select('*')
    .eq('mobile_number', mobile)
    .limit(1);
  if (error) throw error;
  return data && data.length > 0 ? data[0] : null;
};

const q = (s) => `"${String(s).replace(/"/g, '""')}"`;

const DONOR_INSERT_COLS = [
  'mobile_number', 'name', 'bank_donor_name', 'agent_donor_name', 'mobile_2',
  'address_1', 'address_2', 'city', 'pin_code', 'pan_number', 'email',
  'birth_date', 'data_category', 'team', 'agent_name', 'mop', 'donors_bank_name',
  'project_supported', 'account_of', 'category', 'station', 'ngo', 'amount',
  'total_amount', 'donation_count', 'first_donation_date', 'last_donation_date',
  'raw_data', 'first_import_batch_id',
];

const DONOR_UPDATE_SET = [
  `name = COALESCE(NULLIF(EXCLUDED.name, ''), donor_profiles.name)`,
  `bank_donor_name = COALESCE(NULLIF(EXCLUDED.bank_donor_name, ''), donor_profiles.bank_donor_name)`,
  `agent_donor_name = COALESCE(NULLIF(EXCLUDED.agent_donor_name, ''), donor_profiles.agent_donor_name)`,
  `mobile_2 = COALESCE(NULLIF(EXCLUDED.mobile_2, ''), donor_profiles.mobile_2)`,
  `address_1 = COALESCE(NULLIF(EXCLUDED.address_1, ''), donor_profiles.address_1)`,
  `address_2 = COALESCE(NULLIF(EXCLUDED.address_2, ''), donor_profiles.address_2)`,
  `city = COALESCE(NULLIF(EXCLUDED.city, ''), donor_profiles.city)`,
  `pin_code = COALESCE(NULLIF(EXCLUDED.pin_code, ''), donor_profiles.pin_code)`,
  `pan_number = COALESCE(NULLIF(EXCLUDED.pan_number, ''), donor_profiles.pan_number)`,
  `email = COALESCE(NULLIF(EXCLUDED.email, ''), donor_profiles.email)`,
  `birth_date = COALESCE(NULLIF(EXCLUDED.birth_date, ''), donor_profiles.birth_date)`,
  `data_category = COALESCE(NULLIF(EXCLUDED.data_category, ''), donor_profiles.data_category)`,
  `team = COALESCE(NULLIF(EXCLUDED.team, ''), donor_profiles.team)`,
  `agent_name = COALESCE(NULLIF(EXCLUDED.agent_name, ''), donor_profiles.agent_name)`,
  `mop = COALESCE(NULLIF(EXCLUDED.mop, ''), donor_profiles.mop)`,
  `donors_bank_name = COALESCE(NULLIF(EXCLUDED.donors_bank_name, ''), donor_profiles.donors_bank_name)`,
  `project_supported = COALESCE(NULLIF(EXCLUDED.project_supported, ''), donor_profiles.project_supported)`,
  `account_of = COALESCE(NULLIF(EXCLUDED.account_of, ''), donor_profiles.account_of)`,
  `category = COALESCE(NULLIF(EXCLUDED.category, ''), donor_profiles.category)`,
  `station = COALESCE(NULLIF(EXCLUDED.station, ''), donor_profiles.station)`,
  `ngo = COALESCE(NULLIF(EXCLUDED.ngo, ''), donor_profiles.ngo)`,
  `amount = GREATEST(COALESCE(donor_profiles.amount, 0), EXCLUDED.amount)`,
  `total_amount = COALESCE(donor_profiles.total_amount, 0) + EXCLUDED.amount`,
  `donation_count = COALESCE(donor_profiles.donation_count, 0) + 1`,
  `first_donation_date = COALESCE(donor_profiles.first_donation_date, EXCLUDED.first_donation_date)`,
  `last_donation_date = COALESCE(EXCLUDED.last_donation_date, donor_profiles.last_donation_date)`,
  `first_import_batch_id = COALESCE(donor_profiles.first_import_batch_id, EXCLUDED.first_import_batch_id)`,
  `raw_data = COALESCE(donor_profiles.raw_data, EXCLUDED.raw_data)`,
  `updated_at = now()`,
].join(',\n  ');

export const upsertDonorProfilesBatch = async (profiles, importBatchId) => {
  if (!profiles || profiles.length === 0) return 0;
  const BATCH = 500;
  let created = 0;

  for (let i = 0; i < profiles.length; i += BATCH) {
    const chunk = profiles.slice(i, i + BATCH);
    const values = [];
    const rowsSql = [];
    let p = 1;

    for (const pr of chunk) {
      const amount = Number(pr.amount) || 0;
      const row = [
        pr.mobile_number, pr.name || null, pr.bank_donor_name || null, pr.agent_donor_name || null, pr.mobile_2 || null,
        pr.address_1 || null, pr.address_2 || null, pr.city || null, pr.pin_code || null, pr.pan_number || null,
        pr.email || null, pr.birth_date || null, pr.data_category || null, pr.team || null, pr.agent_name || null,
        pr.mop || null, pr.donors_bank_name || null, pr.project_supported || null, pr.account_of || null,
        pr.category || '', pr.station || null, pr.ngo || null,
        amount, amount, 1,
        pr.transaction_date || null, pr.transaction_date || null,
        pr.raw_data ?? null, pr.import_batch_id ?? null,
      ];
      const ph = row.map(() => `$${p++}`);
      rowsSql.push(`(${ph.join(', ')})`);
      values.push(...row);
    }

    const sql = `INSERT INTO donor_profiles (${DONOR_INSERT_COLS.map(q).join(', ')})\n` +
      `VALUES ${rowsSql.join(',\n')}\n` +
      `ON CONFLICT (mobile_number) DO UPDATE SET\n  ${DONOR_UPDATE_SET}\n` +
      `RETURNING first_import_batch_id`;
    const { rows } = await db._pool.query(sql, values);
    for (const r of rows) {
      if (r.first_import_batch_id === importBatchId) created++;
    }
  }

  return created;
};

export const insertDonorProfile = async (profile) => {
  const row = {
    mobile_number: profile.mobile_number,
    name: profile.name || null,
    bank_donor_name: profile.bank_donor_name || null,
    agent_donor_name: profile.agent_donor_name || null,
    mobile_2: profile.mobile_2 || null,
    address_1: profile.address_1 || null,
    address_2: profile.address_2 || null,
    city: profile.city || null,
    pin_code: profile.pin_code || null,
    pan_number: profile.pan_number || null,
    email: profile.email || null,
    birth_date: profile.birth_date || null,
    data_category: profile.data_category || null,
    team: profile.team || null,
    agent_name: profile.agent_name || null,
    mop: profile.mop || null,
    donors_bank_name: profile.donors_bank_name || null,
    project_supported: profile.project_supported || null,
    account_of: profile.account_of || null,
    raw_data: profile.raw_data || null,
    first_import_batch_id: profile.import_batch_id || null,
    category: profile.category || '',
    station: profile.station || null,
    ngo: profile.ngo || null,
    amount: profile.amount || 0,
  };

  const { data, error } = await db
    .from('donor_profiles')
    .insert(row)
    .select('*')
    .single();
  if (error) throw error;
  return data;
};

export const getAllDonorProfiles = async (limit = 500) => {
  const { data, error } = await db
    .from('donor_profiles')
    .select('*')
    .order('first_imported_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data;
};

export const getDonorProfilesByNgo = async (ngoList, limit = 1000) => {
  const { data, error } = await db
    .from('donor_profiles')
    .select('*')
    .in('ngo', ngoList)
    .order('first_imported_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data;
};

export const getDonorProfilesByImportNgo = async (ngoList, limit = 1000) => {
  const { data: mobiles, error: mErr } = await db
    .from('new_data')
    .select('mobile_number')
    .in('ngo', ngoList)
    .not('mobile_number', 'is', null);

  if (mErr) throw mErr;

  const uniqueMobiles = [...new Set(mobiles.map(r => r.mobile_number))];
  if (uniqueMobiles.length === 0) return [];

  // Batch into groups of 500 to avoid Cloudflare 414 URI too large
  const BATCH = 500;
  const batchQueries = [];
  for (let i = 0; i < uniqueMobiles.length; i += BATCH) {
    const batch = uniqueMobiles.slice(i, i + BATCH);
    batchQueries.push(
      db
        .from('donor_profiles')
        .select('*')
        .in('mobile_number', batch)
        .order('first_imported_at', { ascending: false })
    );
  }

  // Run all batches in parallel
  const batchResults = await Promise.allSettled(batchQueries);
  const results = [];
  for (const r of batchResults) {
    if (r.status === 'fulfilled' && r.value.data) {
      results.push(...r.value.data);
    }
  }

  // Dedup by id and apply limit
  const seen = new Set();
  const deduped = results.filter(r => { if (seen.has(r.id)) return false; seen.add(r.id); return true; });
  return deduped.slice(0, limit);
};
