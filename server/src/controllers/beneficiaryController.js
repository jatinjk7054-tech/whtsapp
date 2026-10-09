import {
  generateBeneficiaryCode, createBeneficiary, getBeneficiaryById, getBeneficiaryByCode,
  updateBeneficiary, listBeneficiaries, searchBeneficiaries, getBeneficiaryOverview,
  searchByQRToken, searchByMobile, markKitGiven, deleteBeneficiaries
} from '../models/beneficiaryModel.js';
import { assignCategories, getBeneficiaryCategories } from '../models/beneficiaryCategoryModel.js';
import { getDisabilities, addDisability, removeDisability } from '../models/beneficiaryDisabilityModel.js';
import { getFamilyMembers } from '../models/beneficiaryFamilyModel.js';
import { getEducation } from '../models/beneficiaryEducationModel.js';
import { getEmployment } from '../models/beneficiaryEmploymentModel.js';
import { getAssistances } from '../models/beneficiaryAssistanceModel.js';
import { getDocuments } from '../models/beneficiaryDocumentModel.js';
import { getCards, getActiveCard } from '../models/beneficiaryCardModel.js';
import { getBiometricStatus } from '../models/biometricModel.js';
import { getSourceRecords } from '../models/beneficiarySourceModel.js';
import { getBeneficiaryDistributionHistory } from '../models/distributionModel.js';
import { getBeneficiaryPrograms } from '../models/programBeneficiaryModel.js';
import { logAuditEvent, getAuditLogs } from '../models/auditLogModel.js';
import { getBnfOperatorBySession } from '../models/bnfOperatorModel.js';
import { getTodayAssignment, listOperatorEvents, demoOperatorEvent } from '../models/operatorModel.js';
import { extractAadhaarFromPhoto, ALL_KEYS } from '../utils/aadhaarPhotoOcr.js';
import db from '../config/db.js';

const DOC_BUCKET = 'beneficiary-documents';

const ensureDocBucket = async () => {
  const { data: buckets } = await db.storage.listBuckets();
  const exists = buckets?.some((b) => b.name === DOC_BUCKET);
  if (!exists) {
    await db.storage.createBucket(DOC_BUCKET, { public: true });
  }
};

// Stores a base64-encoded file (e.g. handicap-certificate camera capture)
// into the beneficiary-documents bucket and returns the public URL. Mirrors
// the operator selfie / worker onboarding upload flow.
export const uploadBeneficiaryDocumentBase64 = async (beneficiaryId, documentType, fileBase64, mimeType) => {
  if (!fileBase64) return { fileUrl: null };
  await ensureDocBucket();
  const buffer = Buffer.from(String(fileBase64), 'base64');
  const contentType = mimeType || 'image/jpeg';
  const ext = contentType.split('/')[1] || 'jpg';
  const fileName = `beneficiary_documents/${beneficiaryId}/${(documentType || 'document').replace(/[^a-z0-9]+/gi, '_')}_${Date.now()}.${ext}`;

  let { error: uploadError } = await db.storage
    .from(DOC_BUCKET)
    .upload(fileName, buffer, { contentType, upsert: true });

  if (uploadError?.message?.includes('bucket')) {
    await db.storage.createBucket(DOC_BUCKET, { public: true });
    const retry = await db.storage.from(DOC_BUCKET).upload(fileName, buffer, { contentType, upsert: true });
    if (retry.error) throw retry.error;
  } else if (uploadError) {
    throw uploadError;
  }

  const { data: publicUrlData } = db.storage.from(DOC_BUCKET).getPublicUrl(fileName);
  return { fileUrl: publicUrlData?.publicUrl || null };
};

export const createNewBeneficiary = async (req, res) => {
  try {
    const {
      full_name, first_name, middle_name, last_name, date_of_birth, gender,
      mobile, alternate_mobile, email, address_line_1, address_line_2, area,
      city, district, state, pincode, photo, monthly_family_income, income_category,
      bpl_available, ration_card_available, occupation, mother_name, father_name,
      guardian_name, guardian_occupation, total_family_members, ngo_id, registration_date,
      category_ids, disabilities, family_members, education, employment, assistance_requirements,
      aadhaar_number, needed,
    } = req.body;

    if (!full_name) return res.status(400).json({ message: 'Full name is required' });

    const beneficiary_code = await generateBeneficiaryCode();
    const created_by = req.user?.name || req.user?.email || 'system';

    const beneficiary = await createBeneficiary({
      beneficiary_code, full_name, first_name, middle_name, last_name,
      date_of_birth, gender, mobile, alternate_mobile, email,
      address_line_1, address_line_2, area, city, district, state, pincode, photo,
      monthly_family_income, income_category, bpl_available, ration_card_available,
      occupation, mother_name, father_name, guardian_name, guardian_occupation,
      total_family_members, ngo_id, registration_date, aadhaar_number, needed,
      status: 'ACTIVE', fingerprint_status: 'NOT_REGISTERED',
      created_by, updated_by: created_by,
    });

    if (category_ids && category_ids.length > 0) {
      await assignCategories(beneficiary.id, category_ids);
    }

    // Persist disability records (disability_type + percentage) sent from the
    // operator app. Failures here never block the registration itself, but are
    // surfaced to the caller as warnings instead of being swallowed.
    const warnings = [];
    if (Array.isArray(disabilities)) {
      for (const d of disabilities) {
        if (!d || typeof d !== 'object') continue;
        let saved = false;
        for (let attempt = 1; attempt <= 3 && !saved; attempt++) {
          try {
            await addDisability(beneficiary.id, {
              disability_type: String(d.disability_type || 'General'),
              disability_percentage:
                d.disability_percentage != null && d.disability_percentage !== ''
                  ? Number(d.disability_percentage)
                  : null,
              certificate_available:
                d.certificate_available != null ? Boolean(d.certificate_available) : false,
            });
            saved = true;
          } catch (e) {
            if (attempt === 3) {
              const msg = `Disability details could not be saved (${String(
                d.disability_type || 'General'
              )} — ${e.message}).`;
              console.error(`[beneficiaries] disability save failed for ${beneficiary.id}:`, e.message);
              warnings.push(msg);
            } else {
              await new Promise((r) => setTimeout(r, 400 * attempt));
            }
          }
        }
      }
    }

    await logAuditEvent({
      entity_type: 'beneficiary', entity_id: beneficiary.id,
      beneficiary_id: beneficiary.id, action: 'CREATED',
      details: { beneficiary_code }, performed_by: created_by,
    });

    return res.status(201).json({
      message: 'Beneficiary created',
      beneficiary,
      warnings: warnings.length ? warnings : undefined,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// True when the beneficiary collected their kit within the last 3 calendar
// months — the window in which an event-kit should only be handed out after
// an explicit operator override. Calendar months (not flat 90 days) match the
// app's cutoff: given on Mar 10 → window ends Jun 10.
export function isWithinThreeMonths(dateStr) {
  if (!dateStr) return false;
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return false;
  const cutoff = new Date(date);
  cutoff.setMonth(cutoff.getMonth() + 3);
  return Date.now() <= cutoff.getTime();
}

// Assembles the fully-enriched beneficiary shape (base row + every
// sub-resource) used both by GET /:id and the QR lookup endpoint.
const buildFullBeneficiary = async (id) => {
  const beneficiary = await getBeneficiaryById(id);
  if (!beneficiary) return null;

  const categories = await getBeneficiaryCategories(beneficiary.id);
  const disabilities = await getDisabilities(beneficiary.id);
  const family = await getFamilyMembers(beneficiary.id);
  const education = await getEducation(beneficiary.id);
  const employment = await getEmployment(beneficiary.id);
  const assistances = await getAssistances(beneficiary.id);
  const documents = await getDocuments(beneficiary.id);
  const cards = await getCards(beneficiary.id);
  const activeCard = await getActiveCard(beneficiary.id);
  const biometric = await getBiometricStatus(beneficiary.id);
  const sourceRecords = await getSourceRecords(beneficiary.id);
  const distributions = await getBeneficiaryDistributionHistory(beneficiary.id);
  // A profile must still load on an installation where migration 120 never ran
  // and program_beneficiaries has no columns to query; a failure degrades to an
  // empty list instead of a 500 on the whole profile.
  const programs = await getBeneficiaryPrograms(beneficiary.id).catch(() => []);

  return {
    ...beneficiary,
    categories, disabilities, family, education, employment,
    assistances, documents, cards, activeCard, biometric,
    sourceRecords, distributions, programs,
  };
};

export const getBeneficiary = async (req, res) => {
  try {
    const beneficiary = await buildFullBeneficiary(req.params.id);
    if (!beneficiary) return res.status(404).json({ message: 'Beneficiary not found' });

    return res.json(beneficiary);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// QR / barcode lookup. Resolves the qr_token to its card, then returns the
// full enriched beneficiary so the operator app gets every detail (including
// kit_given_at) in a single request.
export const lookupBeneficiaryByToken = async (req, res) => {
  try {
    const card = await searchByQRToken(req.params.token);
    if (!card || !card.id) return res.status(404).json({ message: 'No beneficiary found for this QR code' });

    const beneficiary = await buildFullBeneficiary(card.id);
    if (!beneficiary) return res.status(404).json({ message: 'No beneficiary found for this QR code' });

    return res.json(beneficiary);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getBeneficiaryByCodeController = async (req, res) => {
  try {
    const beneficiary = await getBeneficiaryByCode(req.params.code);
    if (!beneficiary) return res.status(404).json({ message: 'Beneficiary not found' });
    return res.json(beneficiary);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Deletes one or more beneficiaries and everything attached to them (all
// "details" including fingerprints and documents). Used by both
// DELETE /beneficiaries/:id and POST /beneficiaries/bulk-delete.
export const deleteBeneficiariesController = async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids)
      ? req.body.ids
      : req.params.id
        ? [req.params.id]
        : [];
    const cleanIds = [...new Set(ids.map((n) => parseInt(n, 10)).filter((n) => Number.isInteger(n) && n > 0))];
    if (cleanIds.length === 0) {
      return res.status(400).json({ message: 'No valid beneficiary ids provided' });
    }

    const { deleted } = await deleteBeneficiaries(cleanIds);

    await logAuditEvent({
      entity_type: 'beneficiary', entity_id: cleanIds[0], beneficiary_id: null,
      action: 'BULK_DELETED',
      details: { ids: cleanIds, requested: cleanIds.length, deleted },
      performed_by: req.user?.name || 'system',
    });

    return res.json({ message: `Deleted ${deleted} beneficiary${deleted === 1 ? '' : 'ies'}. All related records removed (documents, fingerprints, disability, family, benefits).`, deleted });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const markBeneficiaryKitGiven = async (req, res) => {
  try {
    const beneficiary = await getBeneficiaryById(req.params.id);
    if (!beneficiary) return res.status(404).json({ message: 'Beneficiary not found' });

    // A kit may only be handed out once every 3 months. If one was given
    // within the window, only an explicit override (operator accepted the
    // "already given on X" prompt) records another handout.
    if (isWithinThreeMonths(beneficiary.kit_given_at) && req.body?.override !== true) {
      const givenOn = beneficiary.kit_given_at
        ? new Date(beneficiary.kit_given_at).toISOString().slice(0, 10)
        : null;
      return res.status(400).json({
        message: givenOn
          ? `Kit already given on ${givenOn}. Would you still want to give this beneficiary the kit?`
          : 'Kit already given. Would you still want to give this beneficiary the kit?',
        withinThreeMonths: true,
        beneficiary,
      });
    }

    const givenBy = req.user?.name || req.user?.email || 'system';
    const updated = await markKitGiven(beneficiary.id, givenBy);

    // Capture the operator's event for the day (if one is assigned) so the
    // kit-given history on the app can show which event the kit was collected at.
    let eventName = null;
    let eventId = null;
    try {
      const worker = await getBnfOperatorBySession(req.user);
      if (worker?.id != null) {
        const today = new Date().toISOString().split('T')[0];
        const assignment = await getTodayAssignment(worker.id, today);
        const ev = assignment?.operator_events;
        if (ev) {
          eventName = ev?.title || ev?.name || null;
          eventId = ev?.id != null ? Number(ev.id) : null;
        }
      }
      // The operator dashboard falls back to the demo event when no real
      // event exists for the day — mirror that so the history shows it too.
      if (!eventName) {
        const today = new Date().toISOString().split('T')[0];
        const events = await listOperatorEvents({ date: today });
        if (!events || events.length === 0) eventName = demoOperatorEvent.title;
      }
    } catch (_) {
      eventName = null;
      eventId = null;
    }

    await logAuditEvent({
      entity_type: 'beneficiary', entity_id: beneficiary.id,
      beneficiary_id: beneficiary.id, action: 'KIT_GIVEN',
      details: {
        beneficiary_code: beneficiary.beneficiary_code,
        event_name: eventName,
        event_id: Number.isInteger(eventId) ? eventId : null,
      },
      performed_by: givenBy,
    });

    return res.json({ message: 'Kit marked as given', beneficiary: updated });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const updateBeneficiaryController = async (req, res) => {
  try {
    const updates = { ...req.body };
    delete updates.id;
    delete updates.beneficiary_code;
    delete updates.created_at;
    delete updates.created_by;
    // Sub-resource payloads are applied through their own tables below — they
    // are not columns of `beneficiaries` and would break the UPDATE.
    delete updates.disabilities;
    delete updates.category_ids;
    delete updates.family_members;
    delete updates.education;
    delete updates.employment;

    const updated_by = req.user?.name || req.user?.email || 'system';
    updates.updated_by = updated_by;

    const beneficiary = await updateBeneficiary(req.params.id, updates);

    if (req.body.category_ids) {
      await assignCategories(beneficiary.id, req.body.category_ids);
    }

    // The operator app edits disabilities together, so replace the whole set
    // when the payload carries one.
    if (Array.isArray(req.body.disabilities)) {
      const existing = await getDisabilities(beneficiary.id);
      for (const d of existing) {
        await removeDisability(d.id);
      }
      for (const d of req.body.disabilities) {
        await addDisability(beneficiary.id, d);
      }
    }

    await logAuditEvent({
      entity_type: 'beneficiary', entity_id: beneficiary.id,
      beneficiary_id: beneficiary.id, action: 'UPDATED',
      details: { fields: Object.keys(updates) }, performed_by: updated_by,
    });

    return res.json({ message: 'Beneficiary updated', beneficiary });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const listAllBeneficiaries = async (req, res) => {
  try {
    const { page, pageSize, search, status, ngo_id, category_id, state, city, kit_given } = req.query;
    const result = await listBeneficiaries({
      page: parseInt(page) || 1,
      pageSize: parseInt(pageSize) || 25,
      search, status, ngo_id: ngo_id ? parseInt(ngo_id) : undefined,
      category_id, state, city, kit_given,
    });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const searchBeneficiariesController = async (req, res) => {
  try {
    const { q } = req.query;
    const results = await searchBeneficiaries(q);
    return res.json(results);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getOverview = async (req, res) => {
  try {
    const overview = await getBeneficiaryOverview();
    return res.json(overview);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const searchByQR = async (req, res) => {
  try {
    const { token } = req.query;
    const result = await searchByQRToken(token);
    if (!result) return res.status(404).json({ message: 'No beneficiary found for this QR code' });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const searchByMobileController = async (req, res) => {
  try {
    const { mobile } = req.query;
    const results = await searchByMobile(mobile);
    return res.json(results);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getAuditTrail = async (req, res) => {
  try {
    const logs = await getAuditLogs(req.params.id);
    return res.json(logs);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Aadhaar QR decoding now lives at POST /api/aadhaar/decode-qr
// (src/aadhaar/routes.js) using @xone-labs/aadharjs with the legacy XML
// decoder as fallback.

// OCRs a photo of an Aadhaar card and returns the same field shape as
// decodeAadhaarQr so the mobile app auto-fills the form. Accepts a base64 JPEG
// (/data:image;base64,... or raw). Uses Gemini vision first, falls back to
// OCR.space + regex heuristics. If everything fails, `detail` explains which
// OCR engine was missing/broken so the operator can fix it server-side.
export const parseAadhaarPhotoController = async (req, res) => {
  try {
    const { image, side } = req.body || {};
    if (!image) {
      return res.status(400).json({ message: 'image is required' });
    }

    // side: 'front' | 'back' | anything else → 'all' (scrape every visible
    // detail, used when a single uploaded Aadhaar document must autofill).
    const sideKey = side === 'front' ? 'front' : side === 'back' ? 'back' : 'all';
    const { fields, via, errors } = await extractAadhaarFromPhoto(String(image), sideKey);
    if (!fields || Object.keys(fields).length === 0) {
      return res.status(422).json({
        message: 'Could not read this card. Make sure the photo is sharp, well-lit, and shows the whole Aadhaar card.',
        detail: errors.join('; ') || 'No OCR engine returned usable text.',
      });
    }

    await logAuditEvent({
      entity_type: 'aadhaar_scan',
      action: 'AADHAAR_PHOTO_SCANNED',
      details: { found: Object.keys(fields).filter((k) => fields[k]).length, via },
      performed_by: req.user?.name || req.user?.email || 'system',
    });

    const discarded = [...new Set([...ALL_KEYS].filter((k) => !(k in fields)))];
    console.log(`[aadhaar OCR] via=${via} found=${Object.keys(fields).join(',')} missing=${discarded.join(',')}`);
    return res.json(fields);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
