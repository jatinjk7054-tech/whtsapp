import {
  createProgram, getProgramById, updateProgram, listPrograms, generateProgramCode,
  addVolunteerRequirement, getVolunteerRequirements,
  addBeneficiaryRequirement, getBeneficiaryRequirements,
  addServiceRequirement, getServiceRequirements,
  addProgramRequirement, getProgramRequirements,
} from '../models/programModel.js';
import {
  assignBeneficiaries, getProgramBeneficiaries, checkInBeneficiary,
  getProgramDashboard, isBeneficiaryRegistered,
} from '../models/programBeneficiaryModel.js';
import { logAuditEvent } from '../models/auditLogModel.js';
import { createOperatorEvent, getOperatorEventByTitleDate } from '../models/operatorModel.js';

export const createNewProgram = async (req, res) => {
  try {
    const {
      ngo_id, title, program_date, start_time, end_time, description,
      location_id, location_name,
      volunteer_requirements, beneficiary_requirements, service_requirements, additional_requirements,
    } = req.body;

    if (!title) return res.status(400).json({ message: 'Program title is required' });

    const program_code = await generateProgramCode();
    const created_by = req.user?.name || req.user?.email || 'system';

    const program = await createProgram({
      program_code, ngo_id, title, program_date, start_time, end_time,
      description, location_id, location_name,
      status: 'DRAFT', created_by,
    });

    // Auto-create an operator event so any event added here also appears in
    // the operator details dropdown on the app (operator_events is what that
    // dropdown reads). Skip if one with the same title + date already exists.
    try {
      const existingEvent = await getOperatorEventByTitleDate(title, program_date || null);
      if (!existingEvent) {
        await createOperatorEvent({
          title,
          description: description || null,
          event_date: program_date || null,
          start_time: start_time || null,
          end_time: end_time || null,
          location: location_name || null,
          state: req.body.state || null,
          created_by,
        });
      }
    } catch (e) {
      console.error('Auto-create operator event failed:', e.message);
    }

    if (volunteer_requirements) {
      for (const vr of volunteer_requirements) {
        await addVolunteerRequirement(program.id, vr);
      }
    }
    if (beneficiary_requirements) {
      for (const br of beneficiary_requirements) {
        await addBeneficiaryRequirement(program.id, br);
      }
    }
    if (service_requirements) {
      for (const sr of service_requirements) {
        await addServiceRequirement(program.id, sr);
      }
    }
    if (additional_requirements) {
      for (const ar of additional_requirements) {
        await addProgramRequirement(program.id, ar);
      }
    }

    await logAuditEvent({
      entity_type: 'program', entity_id: program.id,
      action: 'CREATED', details: { program_code, title }, performed_by: created_by,
    });

    return res.status(201).json({ message: 'Program created', program });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getProgram = async (req, res) => {
  try {
    const program = await getProgramById(req.params.id);
    if (!program) return res.status(404).json({ message: 'Program not found' });

    const volunteerRequirements = await getVolunteerRequirements(program.id);
    const beneficiaryRequirements = await getBeneficiaryRequirements(program.id);
    const serviceRequirements = await getServiceRequirements(program.id);
    const additionalRequirements = await getProgramRequirements(program.id);
    const beneficiaries = await getProgramBeneficiaries(program.id);

    return res.json({
      ...program,
      volunteer_requirements: volunteerRequirements,
      beneficiary_requirements: beneficiaryRequirements,
      service_requirements: serviceRequirements,
      additional_requirements: additionalRequirements,
      beneficiaries,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const updateProgramController = async (req, res) => {
  try {
    const updates = { ...req.body };
    delete updates.id;
    delete updates.program_code;
    updates.updated_by = req.user?.name || req.user?.email || 'system';

    const program = await updateProgram(req.params.id, updates);

    await logAuditEvent({
      entity_type: 'program', entity_id: program.id,
      action: 'UPDATED', details: { fields: Object.keys(updates) },
      performed_by: updates.updated_by,
    });

    return res.json({ message: 'Program updated', program });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const listAllPrograms = async (req, res) => {
  try {
    const { page, pageSize, status, ngo_id, from_date, to_date } = req.query;
    const result = await listPrograms({
      page: parseInt(page) || 1,
      pageSize: parseInt(pageSize) || 25,
      status, ngo_id: ngo_id ? parseInt(ngo_id) : undefined,
      from_date, to_date,
    });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const assignBeneficiariesToProgram = async (req, res) => {
  try {
    const { beneficiary_ids } = req.body;
    if (!beneficiary_ids || !Array.isArray(beneficiary_ids)) {
      return res.status(400).json({ message: 'beneficiary_ids array is required' });
    }

    const result = await assignBeneficiaries(req.params.id, beneficiary_ids);

    await logAuditEvent({
      entity_type: 'program', entity_id: parseInt(req.params.id),
      action: 'BENEFICIARIES_ASSIGNED',
      details: { count: beneficiary_ids.length },
      performed_by: req.user?.name || 'system',
    });

    return res.json({ message: `${result.length} beneficiaries assigned`, assigned: result });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const checkInBeneficiaryToProgram = async (req, res) => {
  try {
    const { beneficiary_id } = req.body;
    if (!beneficiary_id) return res.status(400).json({ message: 'beneficiary_id is required' });

    const programId = parseInt(req.params.id);
    const registered = await isBeneficiaryRegistered(programId, beneficiary_id);
    if (!registered) {
      return res.status(400).json({ message: 'Beneficiary is not registered for this program' });
    }

    const result = await checkInBeneficiary(programId, beneficiary_id, req.user?.name || 'system');

    await logAuditEvent({
      entity_type: 'program_beneficiary', entity_id: programId,
      beneficiary_id, action: 'CHECKED_IN',
      performed_by: req.user?.name || 'system',
    });

    return res.json({ message: 'Beneficiary checked in', checkin: result });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getProgramLiveDashboard = async (req, res) => {
  try {
    const dashboard = await getProgramDashboard(req.params.id);
    if (!dashboard) return res.status(404).json({ message: 'Program not found' });
    return res.json(dashboard);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const scanBeneficiaryQR = async (req, res) => {
  try {
    const { qr_token } = req.body;
    const programId = parseInt(req.params.id);

    // Find beneficiary by QR token
    const { data: card } = await (await import('../config/db.js')).default
      .from('beneficiary_cards')
      .select('beneficiary_id')
      .eq('qr_token', qr_token)
      .eq('status', 'ACTIVE')
      .single();

    if (!card) return res.status(404).json({ message: 'No beneficiary found for this QR code' });

    const { data: beneficiary } = await (await import('../config/db.js')).default
      .from('beneficiaries')
      .select('id, beneficiary_code, full_name, status, mobile, photo')
      .eq('id', card.beneficiary_id)
      .single();

    if (!beneficiary) return res.status(404).json({ message: 'Beneficiary not found' });

    const registered = await isBeneficiaryRegistered(programId, beneficiary.id);

    return res.json({
      beneficiary,
      registered_for_program: registered,
      eligible: beneficiary.status === 'ACTIVE' && registered,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
