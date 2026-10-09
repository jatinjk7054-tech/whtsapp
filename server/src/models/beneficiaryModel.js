import db from '../config/db.js';

export async function generateBeneficiaryCode() {
  const { data: seq, error: seqErr } = await db
    .from('beneficiary_sequences')
    .select('id, current_value')
    .single();

  let current = null;
  if (seqErr && seqErr.code === 'PGRST116') {
    // Sequence table is empty (seed row never inserted). Create it on the
    // fly so registration does not fail.
    const { data: created, error: createErr } = await db
      .from('beneficiary_sequences')
      .insert({ current_value: 0 })
      .select('id, current_value')
      .single();
    if (createErr) throw createErr;
    current = created;
  } else if (seqErr) {
    throw seqErr;
  } else {
    current = seq;
  }

  const next = (current.current_value || 0) + 1;
  const { error: updErr } = await db
    .from('beneficiary_sequences')
    .update({ current_value: next, updated_at: new Date().toISOString() })
    .eq('id', current.id);
  if (updErr) throw updErr;

  return `BS-${String(next).padStart(6, '0')}`;
}

// Reserve a whole block of codes in one read+write. Calling
// generateBeneficiaryCode() per row costs two round-trips each, which is what
// made a 400-row spreadsheet import appear to hang. Codes are handed out from
// the same counter, so a reserved block is simply unused if the import aborts.
export async function reserveBeneficiaryCodes(count) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (n === 0) return [];

  const { data: seq, error: seqErr } = await db
    .from('beneficiary_sequences')
    .select('id, current_value')
    .single();

  let current = null;
  if (seqErr && seqErr.code === 'PGRST116') {
    const { data: created, error: createErr } = await db
      .from('beneficiary_sequences')
      .insert({ current_value: 0 })
      .select('id, current_value')
      .single();
    if (createErr) throw createErr;
    current = created;
  } else if (seqErr) {
    throw seqErr;
  } else {
    current = seq;
  }

  const start = (current.current_value || 0) + 1;
  const { error: updErr } = await db
    .from('beneficiary_sequences')
    .update({ current_value: start + n - 1, updated_at: new Date().toISOString() })
    .eq('id', current.id);
  if (updErr) throw updErr;

  return Array.from({ length: n }, (_, i) => `BS-${String(start + i).padStart(6, '0')}`);
}

// Every member already on file whose number matches one of the sheet's numbers
// (either slot), keyed by the number that matched. One query instead of one per
// row. A member registered under both slots is returned once per number, which
// is what the per-row lookup did too.
export async function findByNumbers(mobiles) {
  const wanted = [...new Set((mobiles || []).filter(Boolean))];
  if (wanted.length === 0) return new Map();

  const found = new Map();
  const CHUNK = 100; // keep the .in() filter inside a safe URL length
  for (let i = 0; i < wanted.length; i += CHUNK) {
    const slice = wanted.slice(i, i + CHUNK);
    const { data, error } = await db
      .from('beneficiaries')
      .select('*')
      .or(`mobile.in.(${slice.join(',')}),alternate_mobile.in.(${slice.join(',')})`);
    if (error) throw error;
    for (const b of data || []) {
      for (const num of slice) {
        if (b.mobile === num || b.alternate_mobile === num) {
          if (!found.has(num)) found.set(num, b);
        }
      }
    }
  }
  return found;
}

// Which columns the beneficiaries table actually has, read once per process.
// The table has grown over time and different installations are at different
// points, so a write names only the columns that exist rather than assuming
// the newest schema. `needed`, for example, is added by the bootstrap repair
// and is absent from migration 120.
let beneficiaryColumnCache = null;
export async function beneficiaryColumns() {
  if (!beneficiaryColumnCache) {
    beneficiaryColumnCache = (async () => {
      // db._pool is raw node-postgres, so the rows come back on `rows` — not on
      // the `data`/`error` shape the query builder returns.
      const { rows, error } = await db._pool.query(
        `select column_name from information_schema.columns
          where table_schema = current_schema() and table_name = 'beneficiaries'`,
      );
      if (error) throw error;
      return new Set((rows || []).map((r) => r.column_name));
    })().catch((e) => { beneficiaryColumnCache = null; throw e; });
  }
  return beneficiaryColumnCache;
}

// Drop any key the table does not have, so one missing column cannot make the
// whole insert fail. Returns the fields that had to be left out.
export const supportedFields = (values, columns) => {
  const kept = {};
  const dropped = [];
  for (const [k, v] of Object.entries(values)) {
    if (columns.has(k)) kept[k] = v; else dropped.push(k);
  }
  return { kept, dropped };
};

export const createBeneficiaries = async (rows) => {
  if (!rows?.length) return [];
  const { data, error } = await db.from('beneficiaries').insert(rows).select('*');
  if (error) throw error;
  return data || [];
};

// Run tasks with a small cap on how many are in flight at once. The importer
// only has per-row work on the merge path (a handful of re-imports), and firing
// those concurrently keeps a re-import from serialising hundreds of updates.
export const runPooled = async (items, limit, task) => {
  const size = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  const workers = Array.from({ length: size }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      await task(items[i], i);
    }
  });
  await Promise.all(workers);
};

export const createBeneficiary = async (data) => {
  const { data: result, error } = await db
    .from('beneficiaries')
    .insert(data)
    .select('*')
    .single();
  if (error) throw error;
  return result;
};

export const getBeneficiaryById = async (id) => {
  const { data, error } = await db
    .from('beneficiaries')
    .select('*, ngos(name, code)')
    .eq('id', id)
    .single();
  if (error) return null;
  return data;
};

export const getBeneficiaryByCode = async (code) => {
  const { data, error } = await db
    .from('beneficiaries')
    .select('*')
    .eq('beneficiary_code', code)
    .single();
  if (error) return null;
  return data;
};

export const updateBeneficiary = async (id, updates) => {
  updates.updated_at = new Date().toISOString();
  const { data, error } = await db
    .from('beneficiaries')
    .update(updates)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data;
};

export const listBeneficiaries = async ({ page = 1, pageSize = 25, search, status, ngo_id, category_id, state, city, kit_given }) => {
  let query = db.from('beneficiaries').select('*, ngos(name, code)', { count: 'exact' });

  if (search) {
    query = query.or(`beneficiary_code.ilike.%${search}%,full_name.ilike.%${search}%,mobile.ilike.%${search}%`);
  }
  if (status) query = query.eq('status', status);
  if (ngo_id) query = query.eq('ngo_id', ngo_id);
  if (state) query = query.eq('state', state);
  if (city) query = query.eq('city', city);
  if (kit_given !== undefined && kit_given !== null) {
    query = query.eq('kit_given', kit_given === true || kit_given === 'true');
  }

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  if (kit_given !== undefined && kit_given !== null) {
    // Kit-given history: newest handout first (matches the app's "Given Today"
    // overview count so the freshly-given beneficiaries appear at the top).
    query = query
      .order('kit_given_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .range(from, to);
  } else {
    query = query.order('created_at', { ascending: false }).range(from, to);
  }

  const { data, error, count } = await query;
  if (error) throw error;
  return { data: data || [], total: count || 0, page, pageSize };
};

export const searchBeneficiaries = async (q) => {
  if (!q || q.length < 2) return [];
  const { data, error } = await db
    .from('beneficiaries')
    .select('id, beneficiary_code, full_name, mobile, status, city, photo, needed')
    .or(`beneficiary_code.ilike.%${q}%,full_name.ilike.%${q}%,mobile.ilike.%${q}%`)
    .limit(20);
  if (error) throw error;
  return data || [];
};

export const getBeneficiaryOverview = async () => {
  const { count: total } = await db.from('beneficiaries').select('id', { count: 'exact', head: true });
  const { count: active } = await db.from('beneficiaries').select('id', { count: 'exact', head: true }).eq('status', 'ACTIVE');
  const { count: inactive } = await db.from('beneficiaries').select('id', { count: 'exact', head: true }).eq('status', 'INACTIVE');
  const { count: pendingFingerprint } = await db.from('beneficiaries').select('id', { count: 'exact', head: true }).eq('fingerprint_status', 'NOT_REGISTERED');

  const thisMonth = new Date();
  thisMonth.setDate(1);
  const { count: newThisMonth } = await db.from('beneficiaries').select('id', { count: 'exact', head: true })
    .gte('created_at', thisMonth.toISOString());

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const { count: kitGivenToday } = await db.from('beneficiaries').select('id', { count: 'exact', head: true })
    .eq('kit_given', true)
    .gte('kit_given_at', todayStart.toISOString());

  const { count: programsCount } = await db.from('bnf_programs').select('id', { count: 'exact', head: true });
  const { count: distributionsCount } = await db.from('benefit_distributions').select('id', { count: 'exact', head: true });

  // Total donations collected (verified receipts). sum.0 so a missing/empty
  // receipts table never breaks the home screen overview.
  const { rows: donationRows } = await db._pool
    .query(`SELECT COALESCE(SUM(amount), 0)::float8 AS total FROM receipts WHERE receipt_no IS NOT NULL`)
    .catch(() => ({ rows: [{ total: 0 }] }));

  // Members per NGO (drives the Beneficiaries app "NGO Members" breakdown).
  const [{ data: ngoIdRows }, { data: ngos }] = await Promise.all([
    db.from('beneficiaries').select('ngo_id'),
    db.from('ngos').select('id, name, code'),
  ]);
  const countByNgo = {};
  for (const r of ngoIdRows || []) {
    const key = r.ngo_id == null ? 'unassigned' : String(r.ngo_id);
    countByNgo[key] = (countByNgo[key] || 0) + 1;
  }
  const ngoBreakdown = (ngos || []).map((n) => ({
    id: n.id,
    name: n.name || `NGO #${n.id}`,
    code: n.code || null,
    count: countByNgo[String(n.id)] || 0,
  }));
  if (countByNgo.unassigned) {
    ngoBreakdown.push({ id: null, name: 'Unassigned', code: null, count: countByNgo.unassigned });
  }
  ngoBreakdown.sort((a, b) => b.count - a.count);

  return {
    total_beneficiaries: total || 0,
    active: active || 0,
    inactive: inactive || 0,
    pending_fingerprint: pendingFingerprint || 0,
    new_this_month: newThisMonth || 0,
    kit_given_today: kitGivenToday || 0,
    total_donated: parseFloat(donationRows[0]?.total) || 0,
    programs: programsCount || 0,
    benefits_distributed: distributionsCount || 0,
    ngos: ngoBreakdown,
  };
};

export const searchByQRToken = async (qrToken) => {
  const { data: card, error: cardErr } = await db
    .from('beneficiary_cards')
    .select('beneficiary_id, card_number, card_type')
    .eq('qr_token', qrToken)
    .eq('status', 'ACTIVE')
    .single();
  if (cardErr || !card) return null;

  const { data: beneficiary, error: benErr } = await db
    .from('beneficiaries')
    .select('id, beneficiary_code, full_name, status, mobile, photo')
    .eq('id', card.beneficiary_id)
    .single();
  if (benErr || !beneficiary) return null;

  return { ...beneficiary, card };
};

export const searchByMobile = async (mobile) => {
  const { data, error } = await db
    .from('beneficiaries')
    .select('id, beneficiary_code, full_name, status, mobile, photo')
    .eq('mobile', mobile)
    .limit(5);
  if (error) throw error;
  return data || [];
};

export const markKitGiven = async (id, givenBy) => {
  const now = new Date().toISOString();
  const { data, error } = await db
    .from('beneficiaries')
    .update({
      kit_given: true,
      kit_given_at: now,
      kit_given_by: givenBy || 'system',
      updated_at: now,
    })
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data;
};

// Tables holding per-beneficiary subordinate data. Deleted explicitly because
// FK constraints are often dropped in the RDS migration — we never rely on
// ON DELETE CASCADE. benefit_distribution_items is handled separately because
// it hangs off benefit_distributions, not beneficiaries directly.
const BENEFICIARY_CHILD_TABLES = [
  'beneficiary_documents',
  'biometric_credentials',
  'beneficiary_cards',
  'beneficiary_disabilities',
  'beneficiary_family_members',
  'beneficiary_education',
  'beneficiary_employment',
  'beneficiary_assistance_requirements',
  'beneficiary_category_assignments',
  'beneficiary_source_records',
  'program_beneficiaries',
];

// Permanently deletes beneficiaries and every record that belongs to them
// (fingerprints, documents, disabilities, family, education, employment,
// assistance, category assignments, cards, source records, program links and
// benefit distributions). audit_logs are intentionally kept as an
// accountability trail. Runs in a single transaction so a failure rolls back
// the whole batch.
export const deleteBeneficiaries = async (ids) => {
  const pool = db._pool;
  const cleanIds = [...new Set((ids || []).map((n) => parseInt(n, 10)).filter((n) => Number.isInteger(n) && n > 0))];
  if (cleanIds.length === 0) return { deleted: 0 };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Benefit distribution items first (they reference distributions).
    await client
      .query(
        `DELETE FROM benefit_distribution_items WHERE distribution_id IN
           (SELECT id FROM benefit_distributions WHERE beneficiary_id = ANY($1::int[]))`,
        [cleanIds]
      )
      .catch(() => {});
    await client
      .query('DELETE FROM benefit_distributions WHERE beneficiary_id = ANY($1::int[])', [cleanIds])
      .catch(() => {});

    for (const t of BENEFICIARY_CHILD_TABLES) {
      await client.query(`DELETE FROM ${t} WHERE beneficiary_id = ANY($1::int[])`, [cleanIds]).catch(() => {});
    }

    // Loosely-referenced staging rows: null the link instead of dropping them.
    await client
      .query('UPDATE import_rows SET beneficiary_id = NULL WHERE beneficiary_id = ANY($1::int[])', [cleanIds])
      .catch(() => {});

    const res = await client.query('DELETE FROM beneficiaries WHERE id = ANY($1::int[])', [cleanIds]);

    await client.query('COMMIT');
    return { deleted: res.rowCount || 0 };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};
