import { Router } from 'express';
import { authenticateRole } from '../middleware/authMiddleware.js';
import {
  createNewBeneficiary, getBeneficiary, getBeneficiaryByCodeController,
  updateBeneficiaryController, listAllBeneficiaries, searchBeneficiariesController,
  getOverview, searchByQR, searchByMobileController, getAuditTrail,
  markBeneficiaryKitGiven, lookupBeneficiaryByToken, deleteBeneficiariesController,
  parseAadhaarPhotoController,
  uploadBeneficiaryDocumentBase64,
} from '../controllers/beneficiaryController.js';
import {
  addDisability, getDisabilities, updateDisability, removeDisability,
} from '../models/beneficiaryDisabilityModel.js';
import {
  addFamilyMember, getFamilyMembers, updateFamilyMember, removeFamilyMember,
} from '../models/beneficiaryFamilyModel.js';
import {
  upsertEducation, getEducation,
} from '../models/beneficiaryEducationModel.js';
import {
  upsertEmployment, getEmployment,
} from '../models/beneficiaryEmploymentModel.js';
import {
  addAssistance, getAssistances, updateAssistance, removeAssistance,
} from '../models/beneficiaryAssistanceModel.js';
import {
  addDocument, getDocuments, updateDocument, removeDocument,
} from '../models/beneficiaryDocumentModel.js';
import { logAuditEvent } from '../models/auditLogModel.js';
import {
  listBnfOperatorsController, createBnfOperatorController, updateBnfOperatorController,
} from '../controllers/bnfOperatorController.js';
import {
  listCatalogController, createCatalogItemController, updateCatalogItemController,
} from '../controllers/bnfCatalogController.js';

const router = Router();

// Overview
router.get('/overview', authenticateRole('super_admin', 'admin', 'ngo', 'accounts', 'event_head', 'worker'), getOverview);

// Aadhaar QR decoding moved to /api/aadhaar/decode-qr (src/aadhaar/routes.js).
// The OCR photo path is kept for the existing document-scan flow. Declared
// before '/:id' so 'aadhaar' is not parsed as an id.
router.post('/aadhaar/parse-photo', authenticateRole('super_admin', 'admin', 'ngo', 'accounts', 'event_head', 'worker'), parseAadhaarPhotoController);

// App operators — the only accounts allowed to log into the Beneficiaries
// mobile app. Declared before /:id so '/operators' is not parsed as an id.
router.get('/operators', authenticateRole('super_admin', 'admin', 'ngo', 'accounts'), listBnfOperatorsController);
router.post('/operators', authenticateRole('super_admin', 'admin', 'ngo', 'accounts'), createBnfOperatorController);
router.patch('/operators/:id', authenticateRole('super_admin', 'admin', 'ngo', 'accounts'), updateBnfOperatorController);

// Kit + organizer catalogs (name lists powering the operator app dropdowns).
router.get('/catalog/:kind', authenticateRole('super_admin', 'admin', 'ngo', 'accounts'), listCatalogController);
router.post('/catalog/:kind', authenticateRole('super_admin', 'admin', 'ngo', 'accounts'), createCatalogItemController);
router.patch('/catalog/:kind/:id', authenticateRole('super_admin', 'admin', 'ngo', 'accounts'), updateCatalogItemController);

// Search
router.get('/search', authenticateRole('super_admin', 'admin', 'ngo', 'accounts', 'event_head', 'worker'), searchBeneficiariesController);
router.get('/search/qr', authenticateRole('super_admin', 'admin', 'ngo', 'event_head', 'worker'), searchByQR);
router.get('/search/mobile', authenticateRole('super_admin', 'admin', 'ngo', 'accounts', 'event_head', 'worker'), searchByMobileController);
// QR lookup used by the operator app — resolves the scanned token to the full
// enriched beneficiary in a single request. Declared before /:id to avoid the
// token being parsed as a numeric id.
router.get('/lookup/:token', authenticateRole('super_admin', 'admin', 'ngo', 'accounts', 'event_head', 'worker'), lookupBeneficiaryByToken);

// CRUD
router.get('/', authenticateRole('super_admin', 'admin', 'ngo', 'accounts', 'event_head', 'worker'), listAllBeneficiaries);
router.post('/', authenticateRole('super_admin', 'admin', 'ngo', 'accounts', 'event_head', 'worker'), createNewBeneficiary);
router.get('/:id', authenticateRole('super_admin', 'admin', 'ngo', 'accounts', 'event_head', 'worker'), getBeneficiary);
router.patch('/:id', authenticateRole('super_admin', 'admin', 'ngo', 'accounts', 'event_head', 'worker'), updateBeneficiaryController);
router.get('/code/:code', authenticateRole('super_admin', 'admin', 'ngo', 'accounts', 'event_head', 'worker'), getBeneficiaryByCodeController);

// Deletion — permanently removes the beneficiary and EVERYTHING attached
// (documents, fingerprints, disability, family, benefits, audit of BULK_DELETED).
router.post('/bulk-delete', authenticateRole('super_admin', 'admin', 'ngo', 'accounts'), deleteBeneficiariesController);
router.delete('/:id', authenticateRole('super_admin', 'admin', 'ngo', 'accounts'), deleteBeneficiariesController);

// Kit given — records that the event kit was handed to the beneficiary
// (operator swipe flow on the beneficiaries app).
router.post('/:id/kit-given', authenticateRole('super_admin', 'admin', 'ngo', 'accounts', 'event_head', 'worker'), markBeneficiaryKitGiven);

// Audit
router.get('/:id/audit', authenticateRole('master', 'super_admin', 'admin', 'ngo', 'accounts', 'event_head', 'worker', 'fro', 'hr', 'recruiter', 'digital'), getAuditTrail);

// Disability sub-resource
router.get('/:id/disabilities', async (req, res) => {
  try { res.json(await getDisabilities(req.params.id)); }
  catch (e) { res.status(500).json({ message: e.message }); }
});
router.post('/:id/disabilities', authenticateRole('super_admin', 'admin', 'ngo', 'accounts'), async (req, res) => {
  try {
    const result = await addDisability(req.params.id, req.body);
    await logAuditEvent({ entity_type: 'disability', beneficiary_id: parseInt(req.params.id), action: 'DISABILITY_ADDED', performed_by: req.user?.name || 'system' });
    res.status(201).json(result);
  } catch (e) { res.status(500).json({ message: e.message }); }
});
router.patch('/disabilities/:disabilityId', authenticateRole('super_admin', 'admin', 'ngo', 'accounts'), async (req, res) => {
  try { res.json(await updateDisability(req.params.disabilityId, req.body)); }
  catch (e) { res.status(500).json({ message: e.message }); }
});
router.delete('/disabilities/:disabilityId', authenticateRole('super_admin', 'admin', 'ngo'), async (req, res) => {
  try { res.json(await removeDisability(req.params.disabilityId)); }
  catch (e) { res.status(500).json({ message: e.message }); }
});

// Family sub-resource
router.get('/:id/family', async (req, res) => {
  try { res.json(await getFamilyMembers(req.params.id)); }
  catch (e) { res.status(500).json({ message: e.message }); }
});
router.post('/:id/family', authenticateRole('super_admin', 'admin', 'ngo', 'accounts'), async (req, res) => {
  try {
    const result = await addFamilyMember(req.params.id, req.body);
    await logAuditEvent({ entity_type: 'family', beneficiary_id: parseInt(req.params.id), action: 'FAMILY_MEMBER_ADDED', performed_by: req.user?.name || 'system' });
    res.status(201).json(result);
  } catch (e) { res.status(500).json({ message: e.message }); }
});
router.patch('/family/:memberId', authenticateRole('super_admin', 'admin', 'ngo', 'accounts'), async (req, res) => {
  try { res.json(await updateFamilyMember(req.params.memberId, req.body)); }
  catch (e) { res.status(500).json({ message: e.message }); }
});
router.delete('/family/:memberId', authenticateRole('super_admin', 'admin', 'ngo'), async (req, res) => {
  try { res.json(await removeFamilyMember(req.params.memberId)); }
  catch (e) { res.status(500).json({ message: e.message }); }
});

// Education sub-resource
router.get('/:id/education', async (req, res) => {
  try { res.json(await getEducation(req.params.id)); }
  catch (e) { res.status(500).json({ message: e.message }); }
});
router.put('/:id/education', authenticateRole('super_admin', 'admin', 'ngo', 'accounts'), async (req, res) => {
  try { res.json(await upsertEducation(req.params.id, req.body)); }
  catch (e) { res.status(500).json({ message: e.message }); }
});

// Employment sub-resource
router.get('/:id/employment', async (req, res) => {
  try { res.json(await getEmployment(req.params.id)); }
  catch (e) { res.status(500).json({ message: e.message }); }
});
router.put('/:id/employment', authenticateRole('super_admin', 'admin', 'ngo', 'accounts'), async (req, res) => {
  try { res.json(await upsertEmployment(req.params.id, req.body)); }
  catch (e) { res.status(500).json({ message: e.message }); }
});

// Assistance sub-resource
router.get('/:id/assistance', async (req, res) => {
  try { res.json(await getAssistances(req.params.id)); }
  catch (e) { res.status(500).json({ message: e.message }); }
});
router.post('/:id/assistance', authenticateRole('super_admin', 'admin', 'ngo', 'accounts'), async (req, res) => {
  try {
    const result = await addAssistance(req.params.id, req.body);
    await logAuditEvent({ entity_type: 'assistance', beneficiary_id: parseInt(req.params.id), action: 'ASSISTANCE_ADDED', performed_by: req.user?.name || 'system' });
    res.status(201).json(result);
  } catch (e) { res.status(500).json({ message: e.message }); }
});
router.patch('/assistance/:assistanceId', authenticateRole('super_admin', 'admin', 'ngo', 'accounts'), async (req, res) => {
  try { res.json(await updateAssistance(req.params.assistanceId, req.body)); }
  catch (e) { res.status(500).json({ message: e.message }); }
});
router.delete('/assistance/:assistanceId', authenticateRole('super_admin', 'admin', 'ngo'), async (req, res) => {
  try { res.json(await removeAssistance(req.params.assistanceId)); }
  catch (e) { res.status(500).json({ message: e.message }); }
});

// Documents sub-resource
router.get('/:id/documents', async (req, res) => {
  try { res.json(await getDocuments(req.params.id)); }
  catch (e) { res.status(500).json({ message: e.message }); }
});
router.post('/:id/documents', authenticateRole('super_admin', 'admin', 'ngo', 'accounts', 'event_head', 'worker'), async (req, res) => {
  try {
    let fileUrl = req.body.file_url;
    // The mobile app uploads a handicap-certificate copy straight from the
    // camera: store the base64 in the beneficiary-documents bucket and attach
    // the URL as file_url.
    if (!fileUrl && req.body.file_base64) {
      const { fileUrl: uploadedUrl } = await uploadBeneficiaryDocumentBase64(
        req.params.id, req.body.document_type, req.body.file_base64, req.body.mime_type
      );
      fileUrl = uploadedUrl;
    }
    const result = await addDocument(req.params.id, {
      ...req.body,
      file_url: fileUrl,
      file_name: req.body.file_name || req.body.document_type || 'document',
    });
    await logAuditEvent({ entity_type: 'document', beneficiary_id: parseInt(req.params.id), action: 'DOCUMENT_UPLOADED', details: { document_type: req.body.document_type }, performed_by: req.user?.name || 'system' });
    res.status(201).json(result);
  } catch (e) { res.status(500).json({ message: e.message }); }
});
router.patch('/documents/:docId', authenticateRole('super_admin', 'admin', 'ngo', 'accounts'), async (req, res) => {
  try { res.json(await updateDocument(req.params.docId, req.body)); }
  catch (e) { res.status(500).json({ message: e.message }); }
});
router.delete('/documents/:docId', authenticateRole('super_admin', 'admin', 'ngo'), async (req, res) => {
  try { res.json(await removeDocument(req.params.docId)); }
  catch (e) { res.status(500).json({ message: e.message }); }
});

export default router;
