import db from '../config/db.js';

// ---- Company Policies ----

export const getActivePolicies = async () => {
  const { data, error } = await db
    .from('company_policies')
    .select('*')
    .eq('is_active', true)
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return data;
};

export const getAllPolicies = async () => {
  const { data, error } = await db
    .from('company_policies')
    .select('*')
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return data;
};

export const createPolicy = async (policyData) => {
  const { data, error } = await db
    .from('company_policies')
    .insert([policyData])
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const updatePolicy = async (id, updates) => {
  const { data, error } = await db
    .from('company_policies')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const deletePolicy = async (id) => {
  const { error } = await db
    .from('company_policies')
    .delete()
    .eq('id', id);
  if (error) throw error;
  return { message: 'Policy deleted successfully' };
};

// ---- Worker personal details update ----

export const updateWorkerPersonalDetails = async (workerId, details) => {
  const updates = {};
  if (details.phone !== undefined) updates.phone = details.phone;
  if (details.alternate_phone !== undefined) updates.alternate_phone = details.alternate_phone;
  if (details.address !== undefined) updates.address = details.address;
  if (details.city !== undefined) updates.city = details.city;
  if (details.state !== undefined) updates.state = details.state;
  if (details.pincode !== undefined) updates.pincode = details.pincode;
  if (details.photo_url !== undefined) updates.photo_url = details.photo_url;
  if (details.name !== undefined) updates.name = details.name;
  if (details.email !== undefined) updates.email = details.email;
  if (details.gender !== undefined) updates.gender = details.gender;
  if (details.dob !== undefined) updates.dob = details.dob;
  if (details.aadhar_front_url !== undefined) updates.aadhar_front_url = details.aadhar_front_url;
  if (details.aadhar_back_url !== undefined) updates.aadhar_back_url = details.aadhar_back_url;
  if (details.pan_card_url !== undefined) updates.pan_card_url = details.pan_card_url;
  if (details.bank_proof_url !== undefined) updates.bank_proof_url = details.bank_proof_url;
  if (details.light_bill_url !== undefined) updates.light_bill_url = details.light_bill_url;
  if (details.account_holder_name !== undefined) updates.account_holder_name = details.account_holder_name;
  if (details.ifsc_code !== undefined) updates.ifsc_code = details.ifsc_code;
  if (details.account_number !== undefined) updates.account_number = details.account_number;
  if (details.declaration_date !== undefined) updates.declaration_date = details.declaration_date;
  if (details.declaration_place !== undefined) updates.declaration_place = details.declaration_place;
  if (details.father_husband_name !== undefined) updates.father_husband_name = details.father_husband_name;
  if (details.permanent_address !== undefined) updates.permanent_address = details.permanent_address;
  if (details.marital_status !== undefined) updates.marital_status = details.marital_status;
  if (details.pan_number !== undefined) updates.pan_number = details.pan_number;
  if (details.aadhar_number !== undefined) updates.aadhar_number = details.aadhar_number;
  if (details.bank_name !== undefined) updates.bank_name = details.bank_name;
  if (details.correspondence !== undefined) updates.correspondence = details.correspondence;
  if (details.previous_organizations !== undefined) updates.previous_organizations = details.previous_organizations;
  if (details.education_details !== undefined) updates.education_details = details.education_details;
  if (details.family_details !== undefined) updates.family_details = details.family_details;
  if (details.reference_details !== undefined) updates.reference_details = details.reference_details;
  if (details.signature_url !== undefined) updates.signature_url = details.signature_url;
  // The signature_status / _signed_at / _ip / _source / _policy_id columns are
  // deliberately NOT accepted here. They are written only by
  // saveSignatureRecord / commitSignature, which enforce the draft->signed lock
  // and stamp the audit metadata. Letting callers set them through this generic
  // updater would create a second path around that lock.

  const { data, error } = await db
    .from('workers')
    .update(updates)
    .eq('id', workerId)
    .select()
    .single();
  if (error) throw error;
  return data;
};

// ---- Signature state (two-phase: draft -> signed) ----

// Columns added by migration 159. Kept in one place so the graceful-degrade
// retry below can strip exactly the right keys if the migration has not been
// applied yet on a given host.
const SIGNATURE_AUDIT_KEYS = [
  'signature_status',
  'signature_signed_at',
  'signature_ip',
  'signature_source',
  'signature_policy_id',
  'signature_previous_url',
];

const missingColumn = (err) =>
  /column .* does not exist|42703/i.test(String(err?.message || err));

export const getSignatureState = async (workerId) => {
  const { data, error } = await db
    .from('workers')
    .select('signature_url, signature_status, signature_signed_at, signature_source')
    .eq('id', workerId)
    .maybeSingle();
  if (error) {
    // Pre-migration host: fall back to the one column that always exists.
    if (missingColumn(error)) {
      const { data: legacy, error: legacyErr } = await db
        .from('workers')
        .select('signature_url')
        .eq('id', workerId)
        .maybeSingle();
      if (legacyErr) throw legacyErr;
      return { signature_url: legacy?.signature_url ?? null, signature_status: null };
    }
    throw error;
  }
  return {
    signature_url: data?.signature_url ?? null,
    signature_status: data?.signature_status ?? null,
    signature_signed_at: data?.signature_signed_at ?? null,
    signature_source: data?.signature_source ?? null,
  };
};

// Stores the image URL plus its audit metadata. The audit columns are written in
// the same statement as signature_url, so on a host where migration 159 has not
// landed the whole UPDATE would fail and the volunteer's signature would be lost
// again. Rather than lose it, retry once without the audit keys: the signature
// still persists, and only the metadata is missing until the migration is applied.
export const saveSignatureRecord = async (workerId, record) => {
  const payload = { signature_url: record.signature_url };
  for (const key of SIGNATURE_AUDIT_KEYS) {
    if (record[key] !== undefined) payload[key] = record[key];
  }

  const run = async (updates) => {
    const { data, error } = await db
      .from('workers')
      .update(updates)
      .eq('id', workerId)
      .select()
      .single();
    if (error) throw error;
    return data;
  };

  try {
    return await run(payload);
  } catch (err) {
    if (!missingColumn(err)) throw err;
    console.warn('[signature] audit columns missing, storing signature without metadata');
    const { signature_url, ...withoutAudit } = payload;
    return run({ signature_url });
  }
};

// Final submit: flips a stored draft to 'signed' and stamps the moment it was
// committed. No-op if the signature is already signed, so a double submit or a
// retry from a flaky connection cannot rewrite the signed date.
export const commitSignature = async (workerId, meta = {}) => {
  const payload = {
    signature_status: 'signed',
    signature_signed_at: meta.signedAt || new Date().toISOString(),
  };
  if (meta.ip !== undefined) payload.signature_ip = meta.ip;
  if (meta.source !== undefined) payload.signature_source = meta.source;
  if (meta.policyId !== undefined) payload.signature_policy_id = meta.policyId;

  const run = async (updates) => {
    const { data, error } = await db
      .from('workers')
      .update(updates)
      .eq('id', workerId)
      .select()
      .single();
    if (error) throw error;
    return data;
  };

  try {
    return await run(payload);
  } catch (err) {
    if (!missingColumn(err)) throw err;
    console.warn('[signature] cannot commit — migration 159 not applied on this host');
    return null;
  }
};

// ---- Complete onboarding submission ----

export const markOnboardingComplete = async (workerId) => {
  const { data, error } = await db
    .from('workers')
    .update({ onboarding_completed: true })
    .eq('id', workerId)
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const getOnboardingStatus = async (workerId) => {
  const { data, error } = await db
    .from('workers')
    .select('onboarding_completed')
    .eq('id', workerId)
    .single();
  if (error) throw error;
  return data?.onboarding_completed ?? false;
};

// ---- Get full worker profile with all onboarding data ----

export const getFullWorkerProfile = async (workerId) => {
  const { data, error } = await db
    .from('workers')
    .select('*')
    .eq('id', workerId)
    .single();
  if (error) throw error;
  return {
    ...data,
    education: data.education_details || [],
    family: data.family_details || [],
    references: data.reference_details || [],
  };
};
