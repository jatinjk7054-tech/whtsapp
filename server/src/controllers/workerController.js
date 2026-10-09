import bcrypt from 'bcryptjs';
import {
  createWorker,
  createWorkers,
  getAllWorkers,
  getWorkerById,
  getWorkerByLoginId,
  getNextEmployeeIdNumber,
  getWorkerCount,
  updateWorker,
  deleteWorker,
  abscondWorker as abscondWorkerModel,
  offboardWorker as offboardWorkerModel,
} from '../models/workerModel.js';
import {
  getAllocationsByWorker,
  setAllocations,
} from '../models/workerNgoAllocationModel.js';
import { updateWorkerPersonalDetails, getFullWorkerProfile } from '../models/onboardingModel.js';
import { presignSignatureUrl, presignSignatureUrls } from '../services/signatureMediaLink.js';
import { getActiveSalaryByWorker } from '../models/salaryModel.js';
import {
  parseDocumentsValue,
  serializeDocuments,
} from '../utils/documentsValue.js';
import { istDateString } from '../utils/ist.js';

const generateLoginId = async (name) => {
  const parts = name.trim().split(/\s+/);
  const firstName = parts[0].toLowerCase().replace(/[^a-z0-9]/g, '');
  const surname = parts.length > 1
    ? parts[parts.length - 1].toLowerCase().replace(/[^a-z0-9]/g, '')
    : '';
  const base = surname ? `${firstName}.${surname}` : firstName;
  let candidate = `${base}@ufs`;
  let counter = 2;
  while (true) {
    const existing = await getWorkerByLoginId(candidate);
    if (!existing) return candidate;
    candidate = `${base}${counter}@ufs`;
    counter++;
  }
};

const generateRandomPassword = () => {
  return '123456';
};

const generateSecurePassword = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let pwd = '';
  for (let i = 0; i < 8; i++) pwd += chars[Math.floor(Math.random() * chars.length)];
  return pwd;
};

const formatEmployeeId = (n) => `UFS-${String(n).padStart(4, '0')}`;

// Returns a function that hands out the next sequential employee_id.
const makeEmployeeIdGenerator = async () => {
  let next = await getNextEmployeeIdNumber();
  return () => formatEmployeeId(next++);
};

function validateAllocations(allocations, salary) {
  if (!allocations || !Array.isArray(allocations) || allocations.length === 0) {
    return { valid: false, message: 'At least one NGO allocation is required' };
  }
  if (allocations.length > 4) {
    return { valid: false, message: 'Maximum 4 NGO allocations allowed' };
  }
  const totalPortion = allocations.reduce((sum, a) => sum + (parseFloat(a.salary_portion) || 0), 0);
  if (Math.abs(totalPortion - parseFloat(salary)) > 0.01) {
    return { valid: false, message: `Allocation portions (${totalPortion}) must sum to salary (${salary})` };
  }
  for (const a of allocations) {
    if (!a.ngo_id) {
      return { valid: false, message: 'Each allocation must have an NGO' };
    }
  }
  return { valid: true };
}

export const addWorker = async (req, res) => {
  try {
    const { name, email, gender, dob, ngo_id, department, allocations, team, is_test } = req.body;
    if (!name) {
      return res.status(400).json({ message: 'Name is required' });
    }

    // Build allocations: use new format or fallback to legacy ngo_id
    let finalAllocations = allocations;
    if (!finalAllocations && ngo_id) {
      finalAllocations = [{ ngo_id, salary_portion: 0 }];
    }

    const tempPassword = generateRandomPassword();
    const login_id = await generateLoginId(name);
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(tempPassword, salt);
    const nextEmployeeId = await makeEmployeeIdGenerator();

    const workerData = {
      name,
      email,
      login_id,
      employee_id: req.body.employee_id || nextEmployeeId(),
      password: hashedPassword,
      gender: gender || null,
      dob: dob || null,
      ngo_id: (finalAllocations && finalAllocations[0]?.ngo_id) || req.user.ngo_id || null,
      department: department || null,
      team: team != null && String(team).trim() !== '' ? String(team).trim().toUpperCase() : null,
      is_test: !!is_test,
      created_by: req.user.id,
    };

    const worker = await createWorker(workerData);

    // Create allocations
    if (finalAllocations && finalAllocations.length > 0) {
      await setAllocations(worker.id, finalAllocations.map(a => ({
        ngo_id: a.ngo_id,
        salary_portion: parseFloat(a.salary_portion) || 0,
      })));
    }

    return res.status(201).json({
      message: 'Worker added successfully',
      worker: {
        id: worker.id,
        name: worker.name,
        email: worker.email,
        login_id: worker.login_id,
        employee_id: worker.employee_id,
        gender: worker.gender,
        dob: worker.dob,
        department: worker.department,
        generated_password: tempPassword,
      },
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const bulkAddWorkers = async (req, res) => {
  try {
    const { workers } = req.body;
    if (!workers || !Array.isArray(workers) || workers.length === 0) {
      return res.status(400).json({ message: 'Workers array is required' });
    }
    const tempPassword = generateRandomPassword();
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(tempPassword, salt);
    const nextEmployeeId = await makeEmployeeIdGenerator();
    const prepared = [];
    for (let i = 0; i < workers.length; i++) {
      const w = workers[i];
      const login_id = await generateLoginId(w.name);
      prepared.push({
        name: w.name,
        email: w.email,
        login_id,
        employee_id: w.employee_id || nextEmployeeId(),
        password: hashedPassword,
        gender: w.gender || null,
        dob: w.dob || null,
        ngo_id: w.ngo_id || (w.allocations?.[0]?.ngo_id) || req.user.ngo_id || null,
        team: w.team != null && String(w.team).trim() !== '' ? String(w.team).trim().toUpperCase() : null,
        created_by: req.user.id,
      });
    }
    const created = await createWorkers(prepared);
    // Create allocations if provided
    for (let i = 0; i < created.length; i++) {
      if (workers[i].allocations && workers[i].allocations.length > 0) {
        await setAllocations(created[i].id, workers[i].allocations.map(a => ({
          ngo_id: a.ngo_id,
          salary_portion: parseFloat(a.salary_portion) || 0,
        })));
      }
    }
    return res.status(201).json({
      message: `${created.length} workers added successfully`,
      workers: created.map((w) => ({
        id: w.id,
        name: w.name,
        email: w.email,
        login_id: w.login_id,
        employee_id: w.employee_id,
        gender: w.gender,
        dob: w.dob,
        generated_password: tempPassword,
      })),
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const resetWorkerPassword = async (req, res) => {
  try {
    const worker = await getWorkerById(req.params.id);
    if (!worker) {
      return res.status(404).json({ message: 'Worker not found' });
    }
    const newPassword = req.body && req.body.password ? String(req.body.password) : generateSecurePassword();
    if (newPassword.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters' });
    }
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);
    await updateWorker(worker.id, { password: hashedPassword });
    return res.json({
      message: 'Password reset successfully',
      login_id: worker.login_id,
      generated_password: newPassword,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getWorkers = async (req, res) => {
  try {
    const allScope = req.query.scope === 'all';
    const ngoId = allScope
      ? null
      : (['hr', 'accounts'].includes(req.user.role) ? null : (req.user.ngo_id || req.query.ngo_id));
    const status = req.query.status || 'active';
    const workers = await getAllWorkers(ngoId, status);
    const salaries = await Promise.all(workers.map(w =>
      getActiveSalaryByWorker(w.id).then(s => ({ id: w.id, salary: s ? parseFloat(s.salary) : null }))
    ));
    const salaryMap = Object.fromEntries(salaries.map(s => [s.id, s.salary]));
    const full = req.query.full === 'true';
    const safeWorkers = workers.map((w) => {
      const base = {
        id: w.id,
        name: w.name,
        email: w.email,
        login_id: w.login_id,
        employee_id: w.employee_id,
        gender: w.gender,
        dob: w.dob,
        phone: w.phone,
        alternate_phone: w.alternate_phone,
        department: w.department,
        team: w.team || null,
        address: w.address,
        city: w.city,
        state: w.state,
        pincode: w.pincode,
        permanent_address: w.permanent_address,
        photo_url: w.photo_url,
        // Signed just below, before the response is sent.
        signature_url: w.signature_url,
        // The ODAR letter and the HR forms gate the signature on
        // signature_status (see client/src/panels/hr/signatureUtils.js). Without
        // these three, isSignatureSigned() saw an undefined status and treated
        // every row as signed -- including drafts that were saved but never
        // submitted.
        signature_status: w.signature_status ?? null,
        signature_signed_at: w.signature_signed_at ?? null,
        signature_source: w.signature_source ?? null,
        is_active: w.is_active,
        is_test: !!w.is_test,
        employment_status: w.employment_status || 'active',
        ngo_id: w.ngo_id,
        created_at: w.created_at,
        salary: salaryMap[w.id],
        documents_submitted: !!w.documents_submitted,
        documents_value: w.documents_value || null,
        // Sent raw so each surface can parse the legacy/array forms itself via
        // parseDocumentsValue, rather than being handed one pre-joined string.
        documents_other: w.documents_other || null,
        late_grace_minutes: w.late_grace_minutes ?? null,
        father_husband_name: w.father_husband_name,
        marital_status: w.marital_status,
        pan_number: w.pan_number,
        aadhar_number: w.aadhar_number,
        account_holder_name: w.account_holder_name,
        bank_name: w.bank_name,
        ifsc_code: w.ifsc_code,
        account_number: w.account_number,
        correspondence: w.correspondence || {},
        education: w.education_details || [],
        family: w.family_details || [],
        previous_organizations: w.previous_organizations || [],
      };
      if (full) {
        return {
          ...base,
          aadhar_front_url: w.aadhar_front_url,
          aadhar_back_url: w.aadhar_back_url,
          pan_card_url: w.pan_card_url,
          bank_proof_url: w.bank_proof_url,
          light_bill_url: w.light_bill_url,
          declaration_date: w.declaration_date,
          declaration_place: w.declaration_place,
          previous_organizations: w.previous_organizations || [],
          correspondence: w.correspondence || {},
          education: w.education_details || [],
          family: w.family_details || [],
          references: w.reference_details || [],
          shift_start_time: w.shift_start_time,
          shift_end_time: w.shift_end_time,
          late_grace_minutes: w.late_grace_minutes ?? null,
          onboarding_completed: w.onboarding_completed,
        };
      }
      return base;
    });
    // signature_url holds a raw, unsigned bucket URL. It 403s for any anonymous
    // reader since the bucket's public-access block was applied, so the browser
    // was handed a link that could not load. Sign each one here, at response
    // time, as a short-lived GetObject URL. Signing is local SigV4 maths, so this
    // costs no S3 round trips, and the stored column is left alone -- a signed
    // URL must never be persisted.
    const signedSignatures = await presignSignatureUrls(safeWorkers.map((w) => w.signature_url));
    safeWorkers.forEach((w, i) => { w.signature_url = signedSignatures[i]; });
    return res.json(safeWorkers);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getMyProfile = async (req, res) => {
  try {
    const profile = await getFullWorkerProfile(req.user.id);
    if (!profile) {
      return res.status(404).json({ message: 'Worker not found' });
    }
    // The volunteer and HR onboarding forms both read signature_url off this
    // payload and render it, so it has to be signed on the way out for the same
    // reason as the list. Copied rather than mutated: the row object is the
    // caller's to keep.
    return res.json({
      ...profile,
      signature_url: await presignSignatureUrl(profile.signature_url),
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getWorker = async (req, res) => {
  try {
    const profile = await getFullWorkerProfile(req.params.id);
    if (!profile) {
      return res.status(404).json({ message: 'Worker not found' });
    }
    const p = profile;
    const activeSalary = await getActiveSalaryByWorker(req.params.id);
    return res.json({
      id: p.id,
      name: p.name,
      email: p.email,
      login_id: p.login_id,
      employee_id: p.employee_id,
      gender: p.gender,
      dob: p.dob,
      phone: p.phone,
      alternate_phone: p.alternate_phone,
      department: p.department,
      address: p.address,
      city: p.city,
      state: p.state,
      pincode: p.pincode,
      permanent_address: p.permanent_address,
      photo_url: p.photo_url,
      // Was absent entirely, so the EmployeeDetail signature card and the HR
      // forms declaration block could never show a signature even though the
      // column had a value. Signed on the way out, same reason as the list.
      signature_url: await presignSignatureUrl(p.signature_url),
      signature_status: p.signature_status ?? null,
      signature_signed_at: p.signature_signed_at ?? null,
      signature_source: p.signature_source ?? null,
      is_active: p.is_active,
      employment_status: p.employment_status || 'active',
      onboarding_completed: p.onboarding_completed,
      documents_submitted: p.documents_submitted,
      documents_value: p.documents_value,
      documents_other: p.documents_other,
      ngo_id: p.ngo_id,
      created_at: p.created_at,
      father_husband_name: p.father_husband_name,
      marital_status: p.marital_status,
      pan_number: p.pan_number,
      aadhar_number: p.aadhar_number,
      aadhar_front_url: p.aadhar_front_url,
      aadhar_back_url: p.aadhar_back_url,
      pan_card_url: p.pan_card_url,
      bank_proof_url: p.bank_proof_url,
      light_bill_url: p.light_bill_url,
      account_holder_name: p.account_holder_name,
      bank_name: p.bank_name,
      ifsc_code: p.ifsc_code,
      account_number: p.account_number,
      declaration_date: p.declaration_date,
      declaration_place: p.declaration_place,
      previous_organizations: p.previous_organizations,
      correspondence: p.correspondence || {},
      education: p.education || [],
      family: p.family || [],
      references: p.references || [],
      salary: activeSalary ? parseFloat(activeSalary.salary) : null,
      shift_start_time: p.shift_start_time,
      shift_end_time: p.shift_end_time,
      late_grace_minutes: p.late_grace_minutes ?? null,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const editWorker = async (req, res) => {
  try {
    const {
      name, email, gender, dob, phone, alternate_phone,
      department, address, city, state, pincode,
      permanent_address, father_husband_name, marital_status,
      pan_number, aadhar_number, is_active, ngo_id,
      account_holder_name, bank_name, ifsc_code, account_number, created_at,
      shift_start_time, shift_end_time,
      photo_url,
      correspondence,
      employment_status,
      education, family, previous_organizations, references,
      declaration_date, declaration_place,
      team,
      is_test,
      documents_submitted,
      documents_value,
      documents_other,
      late_grace_minutes,
    } = req.body;
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (email !== undefined) updates.email = email;
    if (gender !== undefined) updates.gender = gender;
    if (dob !== undefined) updates.dob = dob || null;
    if (phone !== undefined) updates.phone = phone;
    if (alternate_phone !== undefined) updates.alternate_phone = alternate_phone;
    if (department !== undefined) updates.department = department;
    if (team !== undefined) updates.team = team != null && String(team).trim() !== '' ? String(team).trim().toUpperCase() : null;
    if (is_test !== undefined) updates.is_test = !!is_test;
    if (documents_submitted !== undefined) updates.documents_submitted = !!documents_submitted;
    // Accepts a JSON array string, a real array, or a legacy single value, and
    // always stores the array form. documents_other carries the "Other" name, and
    // a null selection clears both so no orphaned name is left behind.
    if (documents_value !== undefined) {
      const parsed = parseDocumentsValue(documents_value, documents_other);
      const written = serializeDocuments(parsed.selected, parsed.otherText);
      const hasAny = parsed.selected.length > 0;
      updates.documents_value = hasAny ? written.documents_value : null;
      updates.documents_other = written.documents_other;
      updates.documents_submitted = hasAny;
    }
    if (address !== undefined) updates.address = address;
    if (city !== undefined) updates.city = city;
    if (state !== undefined) updates.state = state;
    if (pincode !== undefined) updates.pincode = pincode;
    if (permanent_address !== undefined) updates.permanent_address = permanent_address;
    if (father_husband_name !== undefined) updates.father_husband_name = father_husband_name;
    if (marital_status !== undefined) updates.marital_status = marital_status;
    if (pan_number !== undefined) updates.pan_number = pan_number;
    if (aadhar_number !== undefined) updates.aadhar_number = aadhar_number;
    if (is_active !== undefined) {
      updates.is_active = is_active;
      if (is_active === true) updates.employment_status = 'active';
    }
    if (ngo_id !== undefined) updates.ngo_id = ngo_id || null;
    if (account_holder_name !== undefined) updates.account_holder_name = account_holder_name;
    if (bank_name !== undefined) updates.bank_name = bank_name;
    if (ifsc_code !== undefined) updates.ifsc_code = ifsc_code;
    if (account_number !== undefined) updates.account_number = account_number;
    if (created_at !== undefined) updates.created_at = created_at.includes('T') ? created_at : created_at + 'T00:00:00.000Z';
    if (shift_start_time !== undefined) updates.shift_start_time = shift_start_time;
    if (shift_end_time !== undefined) updates.shift_end_time = shift_end_time;
    if (late_grace_minutes !== undefined) {
      if (late_grace_minutes === null || late_grace_minutes === '') {
        updates.late_grace_minutes = null;
      } else {
        const n = Number(late_grace_minutes);
        if (!Number.isFinite(n) || Math.round(n) < 30 || Math.round(n) > 480) {
          return res.status(400).json({ message: 'late_grace_minutes must be null or 30–480' });
        }
        updates.late_grace_minutes = Math.round(n);
      }
    }
    if (photo_url !== undefined) updates.photo_url = photo_url;
    if (correspondence !== undefined) updates.correspondence = correspondence;
    if (employment_status !== undefined) {
      updates.employment_status = employment_status;
      if (employment_status !== 'active') updates.is_active = false;
    }
    if (education !== undefined) updates.education_details = education;
    if (family !== undefined) updates.family_details = family;
    if (previous_organizations !== undefined) updates.previous_organizations = previous_organizations;
    if (references !== undefined) updates.reference_details = references;
    if (declaration_date !== undefined) updates.declaration_date = declaration_date || null;
    if (declaration_place !== undefined) updates.declaration_place = declaration_place;
    const worker = await updateWorker(req.params.id, updates);
    return res.json({ message: 'Worker updated successfully', worker });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const bulkEditWorkers = async (req, res) => {
  try {
    const { workers } = req.body;
    if (!Array.isArray(workers) || workers.length === 0) {
      return res.status(400).json({ message: 'workers array is required' });
    }
    const updated = [];
    for (const w of workers) {
      const updates = {};
      if (w.phone !== undefined) updates.phone = w.phone;
      if (w.alternate_phone !== undefined) updates.alternate_phone = w.alternate_phone;
      if (w.name !== undefined) updates.name = w.name;
      if (w.email !== undefined) updates.email = w.email;
      if (Object.keys(updates).length > 0) {
        const worker = await updateWorker(w.id, updates);
        updated.push(worker);
      }
    }
    return res.json({ message: `${updated.length} workers updated`, updated });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getBirthdays = async (req, res) => {
  try {
    const workers = await getAllWorkers(null);
    const today = new Date();
    const todayIst = istDateString(today);
    const todayMD = todayIst.slice(5);
    const upcoming = workers
      .filter((w) => w.dob)
      .filter((w) => !(w.is_active === false || ['terminated', 'absconded'].includes(String(w.employment_status || '').toLowerCase().trim())))
      .map((w) => {
        const dob = new Date(w.dob);
        const md = `${String(dob.getMonth() + 1).padStart(2, '0')}-${String(dob.getDate()).padStart(2, '0')}`;
        const diffDays = (new Date(today.getFullYear(), dob.getMonth(), dob.getDate()) - today) / 86400000;
        const isToday = md === todayMD;
        return { ...w, _md: md, _diff: isToday ? 0 : (diffDays >= 0 ? diffDays : diffDays + 365) };
      })
      .filter((w) => w._diff <= 30)
      .sort((a, b) => a._diff - b._diff)
      .slice(0, 10)
      .map(({ password, _md, _diff, ...rest }) => ({
        ...rest,
        birthdayInDays: Math.round(_diff),
      }));
    return res.json(upcoming);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getAnniversaries = async (req, res) => {
  try {
    const workers = await getAllWorkers(null);
    const today = new Date();
    const todayMD = `${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const upcoming = workers
      .filter((w) => w.created_at)
      .filter((w) => !(w.is_active === false || ['terminated', 'absconded'].includes(String(w.employment_status || '').toLowerCase().trim())))
      .map((w) => {
        const joinDate = new Date(w.created_at);
        if (isNaN(joinDate.getTime())) return null;
        const years = today.getFullYear() - joinDate.getFullYear();
        if (years < 1) return null;
        const md = `${String(joinDate.getMonth() + 1).padStart(2, '0')}-${String(joinDate.getDate()).padStart(2, '0')}`;
        const diffDays = (new Date(today.getFullYear(), joinDate.getMonth(), joinDate.getDate()) - today) / 86400000;
        const isToday = md === todayMD;
        return { ...w, _md: md, _diff: isToday ? 0 : (diffDays >= 0 ? diffDays : diffDays + 365), _years: years };
      })
      .filter(Boolean)
      .filter((w) => w._diff <= 30)
      .sort((a, b) => a._diff - b._diff)
      .slice(0, 10)
      .map(({ password, _md, _diff, _years, ...rest }) => ({
        ...rest,
        anniversaryInDays: Math.round(_diff),
        yearsCompleted: _years,
      }));
    return res.json(upcoming);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const removeWorker = async (req, res) => {
  try {
    const data = await deleteWorker(req.params.id);
    return res.json({ message: 'Worker deleted', worker: data });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const abscondWorkerHandler = async (req, res) => {
  try {
    const data = await abscondWorkerModel(req.params.id);
    return res.json({ message: 'Worker marked as absconded', worker: data });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const offboardWorkerHandler = async (req, res) => {
  try {
    const data = await offboardWorkerModel(req.params.id);
    return res.json({ message: 'Worker offboarded', worker: data });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const updateMyProfile = async (req, res) => {
  try {
    const allowed = [
      'name', 'email', 'phone', 'alternate_phone', 'address', 'permanent_address',
      'city', 'state', 'pincode', 'gender', 'dob',
      'father_husband_name', 'marital_status', 'pan_number', 'aadhar_number',
      'account_holder_name', 'bank_name', 'ifsc_code', 'account_number',
      'photo_url',
    ];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    // Which documents the volunteer handed over. Not in `allowed` because it needs
    // normalising and it also derives documents_submitted, mirroring editWorker.
    // The submitted form writes this straight from checkboxes, so it may arrive as
    // an array, an array string, or a legacy single value; all three are accepted.
    // Unrecognised entries are dropped rather than rejected, because this is
    // self-service and a volunteer must never be locked out of signing over a
    // stray value — an empty selection is simply ignored.
    if (req.body.documents_value !== undefined) {
      const parsed = parseDocumentsValue(req.body.documents_value, req.body.documents_other);
      const written = serializeDocuments(parsed.selected, parsed.otherText);
      const hasAny = parsed.selected.length > 0;
      updates.documents_value = hasAny ? written.documents_value : null;
      updates.documents_other = written.documents_other;
      updates.documents_submitted = hasAny;
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: 'No valid fields to update' });
    }
    const worker = await updateWorker(req.user.id, updates);
    return res.json({ message: 'Profile updated', worker });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const updateMyEducation = async (req, res) => {
  try {
    const { education } = req.body;
    if (!education || !Array.isArray(education)) {
      return res.status(400).json({ message: 'Education list is required' });
    }
    await updateWorkerPersonalDetails(req.user.id, { education_details: education });
    return res.json({ message: 'Education updated', education });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getWorkerAllocations = async (req, res) => {
  try {
    const rows = await getAllocationsByWorker(req.params.id);
    return res.json(rows);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const setWorkerAllocations = async (req, res) => {
  try {
    const { allocations, salary } = req.body;
    if (!allocations || !Array.isArray(allocations) || allocations.length === 0) {
      return res.status(400).json({ message: 'At least one NGO allocation is required' });
    }
    if (allocations.length > 4) {
      return res.status(400).json({ message: 'Maximum 4 NGO allocations allowed' });
    }
    if (salary && parseFloat(salary) > 0) {
      const validation = validateAllocations(allocations, salary);
      if (!validation.valid) {
        return res.status(400).json({ message: validation.message });
      }
    }
    const rows = await setAllocations(req.params.id, allocations.map(a => ({
      ngo_id: a.ngo_id,
      salary_portion: parseFloat(a.salary_portion) || 0,
    })));
    return res.json({ message: 'Allocations updated', allocations: rows });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
