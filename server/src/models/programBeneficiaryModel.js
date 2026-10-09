import db from '../config/db.js';

export const assignBeneficiaries = async (programId, beneficiaryIds) => {
  const rows = beneficiaryIds.map(beneficiary_id => ({
    program_id: programId,
    beneficiary_id,
    attendance_status: 'REGISTERED',
    eligibility_status: 'ELIGIBLE',
    service_status: 'PENDING',
  }));

  const { data, error } = await db
    .from('program_beneficiaries')
    .insert(rows, { onConflict: 'program_id,beneficiary_id', ignoreDuplicates: true })
    .select('*');
  if (error) throw error;
  return data || [];
};

export const getProgramBeneficiaries = async (programId) => {
  const { data, error } = await db
    .from('program_beneficiaries')
    .select('*, beneficiaries(id, beneficiary_code, full_name, mobile, status, photo)')
    .eq('program_id', programId)
    .order('created_at');
  if (error) throw error;
  return data || [];
};

// Every program this beneficiary has been assigned to, newest first, with the
// program's display fields embedded. Used by the beneficiary profile's
// Programs tab so it does not have to page through programs separately.
export const getBeneficiaryPrograms = async (beneficiaryId) => {
  const { data, error } = await db
    .from('program_beneficiaries')
    .select('*, bnf_programs(id, program_code, title, program_date, location_name, status)')
    .eq('beneficiary_id', beneficiaryId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
};

export const checkInBeneficiary = async (programId, beneficiaryId, checkedInBy) => {
  const { data, error } = await db
    .from('program_beneficiaries')
    .update({
      attendance_status: 'CHECKED_IN',
      checked_in_at: new Date().toISOString(),
      checked_in_by: checkedInBy,
    })
    .eq('program_id', programId)
    .eq('beneficiary_id', beneficiaryId)
    .select('*')
    .single();
  if (error) throw error;
  return data;
};

export const checkOutBeneficiary = async (programId, beneficiaryId) => {
  const { data, error } = await db
    .from('program_beneficiaries')
    .update({
      attendance_status: 'CHECKED_OUT',
      checked_out_at: new Date().toISOString(),
    })
    .eq('program_id', programId)
    .eq('beneficiary_id', beneficiaryId)
    .select('*')
    .single();
  if (error) throw error;
  return data;
};

export const updateServiceStatus = async (programId, beneficiaryId, status) => {
  const { data, error } = await db
    .from('program_beneficiaries')
    .update({ service_status: status })
    .eq('program_id', programId)
    .eq('beneficiary_id', beneficiaryId)
    .select('*')
    .single();
  if (error) throw error;
  return data;
};

export const getProgramDashboard = async (programId) => {
  const program = await db.from('bnf_programs').select('*').eq('id', programId).single();
  if (!program.data) return null;

  const { count: totalAssigned } = await db
    .from('program_beneficiaries')
    .select('id', { count: 'exact', head: true })
    .eq('program_id', programId);

  const { count: checkedIn } = await db
    .from('program_beneficiaries')
    .select('id', { count: 'exact', head: true })
    .eq('program_id', programId)
    .eq('attendance_status', 'CHECKED_IN');

  const { count: served } = await db
    .from('program_beneficiaries')
    .select('id', { count: 'exact', head: true })
    .eq('program_id', programId)
    .eq('service_status', 'SERVED');

  const { count: volunteersAssigned } = await db
    .from('program_volunteers')
    .select('id', { count: 'exact', head: true })
    .eq('program_id', programId);

  const { count: volunteersPresent } = await db
    .from('program_volunteers')
    .select('id', { count: 'exact', head: true })
    .eq('program_id', programId)
    .eq('attendance_status', 'PRESENT');

  const { count: distributions } = await db
    .from('benefit_distributions')
    .select('id', { count: 'exact', head: true })
    .eq('program_id', programId);

  return {
    program: program.data,
    beneficiaries: {
      required: program.data.expected_beneficiaries || 0,
      assigned: totalAssigned || 0,
      checked_in: checkedIn || 0,
      served: served || 0,
    },
    volunteers: {
      assigned: volunteersAssigned || 0,
      present: volunteersPresent || 0,
    },
    distributions: distributions || 0,
  };
};

export const isBeneficiaryRegistered = async (programId, beneficiaryId) => {
  const { data } = await db
    .from('program_beneficiaries')
    .select('id')
    .eq('program_id', programId)
    .eq('beneficiary_id', beneficiaryId)
    .single();
  return !!data;
};
