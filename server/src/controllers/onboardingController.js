import db from '../config/db.js';
import { getWorkerById } from '../models/workerModel.js';
import {
  updateWorkerPersonalDetails,
  markOnboardingComplete,
  getOnboardingStatus,
  getActivePolicies,
  getAllPolicies,
  createPolicy,
  updatePolicy,
  deletePolicy,
  getFullWorkerProfile,
  getSignatureState,
  saveSignatureRecord,
  commitSignature,
} from '../models/onboardingModel.js';
import { presignSignatureUrl } from '../services/signatureMediaLink.js';

const BUCKET_NAME = 'worker-documents';

const ensureWorkerDocumentsBucket = async () => {
  const { data: buckets } = await db.storage.listBuckets();
  const exists = buckets?.some((b) => b.name === BUCKET_NAME);
  if (!exists) {
    const { error } = await db.storage.createBucket(BUCKET_NAME, { public: true });
    if (error) {
      console.warn('Could not create storage bucket:', error.message);
    } else {
      console.log('Created storage bucket:', BUCKET_NAME);
    }
  }
};

// ---- Submit complete onboarding data ----

export const submitOnboarding = async (req, res) => {
  try {
    const workerId = req.user.id;
    const {
      personal_details,
      education,
      family,
      references,
      previous_organizations,
    } = req.body;

    // 1. Save personal details + education + family + references as JSONB
    if (personal_details) {
      if (previous_organizations) {
        personal_details.previous_organizations = previous_organizations;
      }
      if (education) {
        personal_details.education_details = education;
      }
      if (family) {
        personal_details.family_details = family;
      }
      if (references) {
        personal_details.reference_details = references;
      }
      await updateWorkerPersonalDetails(workerId, personal_details);
    }

    // 2. Mark onboarding as complete
    await markOnboardingComplete(workerId);

    return res.json({
      message: 'Onboarding completed successfully',
      success: true,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ---- Get onboarding status ----

export const checkOnboardingStatus = async (req, res) => {
  try {
    const workerId = req.user.id;
    const completed = await getOnboardingStatus(workerId);
    return res.json({ onboarding_completed: completed });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ---- Upload photo to S3-backed storage ----

export const uploadPhoto = async (req, res) => {
  try {
    await ensureWorkerDocumentsBucket();
    const workerId = req.user.id;
    const { photo_base64, mime_type } = req.body;

    if (!photo_base64) {
      return res.status(400).json({ message: 'Photo data is required' });
    }

    // Decode base64
    const buffer = Buffer.from(photo_base64, 'base64');
    const contentType = mime_type || 'image/jpeg';
    const ext = contentType.split('/')[1] || 'jpg';
    const fileName = `worker_photos/${workerId}_${Date.now()}.${ext}`;

    // Upload to S3-backed storage
    let { data: uploadData, error: uploadError } = await db.storage
      .from('worker-documents')
      .upload(fileName, buffer, {
        contentType,
        upsert: true,
      });

    if (uploadError) {
      // Try creating the bucket if it doesn't exist
      if (uploadError.message?.includes('bucket')) {
        const { error: bucketError } = await db.storage.createBucket('worker-documents', {
          public: true,
        });
        if (bucketError) {
          return res.status(500).json({ message: 'Failed to create storage bucket: ' + bucketError.message });
        }
        // Retry upload
        const { data: retryData, error: retryError } = await db.storage
          .from('worker-documents')
          .upload(fileName, buffer, { contentType, upsert: true });
        if (retryError) {
          return res.status(500).json({ message: 'Upload failed: ' + retryError.message });
        }
        uploadData = retryData;
      } else {
        return res.status(500).json({ message: 'Upload failed: ' + uploadError.message });
      }
    }

    // Get public URL
    const { data: publicUrlData } = db.storage
      .from('worker-documents')
      .getPublicUrl(fileName);

    const photoUrl = publicUrlData?.publicUrl;

    // Save photo URL to worker record
    await updateWorkerPersonalDetails(workerId, { photo_url: photoUrl });

    return res.json({
      message: 'Photo uploaded successfully',
      photo_url: photoUrl,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ---- Upload document (aadhar front/back, pan card, bank proof) ----

export const uploadDocument = async (req, res) => {
  try {
    await ensureWorkerDocumentsBucket();
    const workerId = req.user.id;
    const { document_type, file_base64, mime_type } = req.body;

    if (!document_type || !file_base64) {
      return res.status(400).json({ message: 'Document type and file data are required' });
    }

    const allowedTypes = ['aadhar_front', 'aadhar_back', 'pan_card', 'bank_proof', 'light_bill'];
    if (!allowedTypes.includes(document_type)) {
      return res.status(400).json({ message: 'Invalid document type' });
    }

    const buffer = Buffer.from(file_base64, 'base64');
    const contentType = mime_type || 'image/jpeg';
    const ext = contentType.split('/')[1] || 'jpg';
    const fileName = `worker_documents/${workerId}/${document_type}_${Date.now()}.${ext}`;

    let { data: uploadData, error: uploadError } = await db.storage
      .from('worker-documents')
      .upload(fileName, buffer, { contentType, upsert: true });

    if (uploadError) {
      if (uploadError.message?.includes('bucket')) {
        const { error: bucketError } = await db.storage.createBucket('worker-documents', { public: true });
        if (bucketError) {
          return res.status(500).json({ message: 'Failed to create storage bucket: ' + bucketError.message });
        }
        const { data: retryData, error: retryError } = await db.storage
          .from('worker-documents')
          .upload(fileName, buffer, { contentType, upsert: true });
        if (retryError) {
          return res.status(500).json({ message: 'Upload failed: ' + retryError.message });
        }
        uploadData = retryData;
      } else {
        return res.status(500).json({ message: 'Upload failed: ' + uploadError.message });
      }
    }

    const { data: publicUrlData } = db.storage
      .from('worker-documents')
      .getPublicUrl(fileName);

    const documentUrl = publicUrlData?.publicUrl;

    return res.json({
      message: 'Document uploaded successfully',
      document_url: documentUrl,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ---- Admin: Upload photo for a specific worker ----

export const adminUploadPhoto = async (req, res) => {
  try {
    await ensureWorkerDocumentsBucket();
    const workerId = req.params.workerId;
    const { photo_base64, mime_type } = req.body;

    if (!photo_base64) {
      return res.status(400).json({ message: 'Photo data is required' });
    }

    const buffer = Buffer.from(photo_base64, 'base64');
    const contentType = mime_type || 'image/jpeg';
    const ext = contentType.split('/')[1] || 'jpg';
    const fileName = `worker_photos/${workerId}_${Date.now()}.${ext}`;

    let { data: uploadData, error: uploadError } = await db.storage
      .from('worker-documents')
      .upload(fileName, buffer, { contentType, upsert: true });

    if (uploadError) {
      if (uploadError.message?.includes('bucket')) {
        const { error: bucketError } = await db.storage.createBucket('worker-documents', { public: true });
        if (bucketError) {
          return res.status(500).json({ message: 'Failed to create storage bucket: ' + bucketError.message });
        }
        const { data: retryData, error: retryError } = await db.storage
          .from('worker-documents')
          .upload(fileName, buffer, { contentType, upsert: true });
        if (retryError) {
          return res.status(500).json({ message: 'Upload failed: ' + retryError.message });
        }
        uploadData = retryData;
      } else {
        return res.status(500).json({ message: 'Upload failed: ' + uploadError.message });
      }
    }

    const { data: publicUrlData } = db.storage
      .from('worker-documents')
      .getPublicUrl(fileName);

    const photoUrl = publicUrlData?.publicUrl;

    await updateWorkerPersonalDetails(workerId, { photo_url: photoUrl });

    return res.json({
      message: 'Photo uploaded successfully',
      photo_url: photoUrl,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ---- Worker: Upload digital signature ----

// Shared S3 write for both the worker and admin paths. Kept separate from the
// request handling so the two-phase lock logic is not duplicated.
const uploadSignatureImage = async (workerId, buffer, contentType) => {
  await ensureWorkerDocumentsBucket();
  const ext = contentType.split('/')[1] || 'png';
  const fileName = `worker_signatures/${workerId}_${Date.now()}.${ext}`;

  const doUpload = () => db.storage
    .from('worker-documents')
    .upload(fileName, buffer, { contentType, upsert: true });

  let { error: uploadError } = await doUpload();

  if (uploadError && uploadError.message?.includes('bucket')) {
    const { error: bucketError } = await db.storage.createBucket('worker-documents', { public: true });
    if (bucketError) {
      throw new Error('Failed to create storage bucket: ' + bucketError.message);
    }
    ({ error: uploadError } = await doUpload());
  }
  if (uploadError) {
    throw new Error('Upload failed: ' + uploadError.message);
  }

  const { data: publicUrlData } = db.storage
    .from('worker-documents')
    .getPublicUrl(fileName);
  return publicUrlData?.publicUrl;
};

// Body fields the client controls. source is an allowlist rather than a free
// string so the audit trail cannot be polluted with arbitrary values.
const SIGNATURE_SOURCES = new Set(['hr_form', 'submitted_form', 'admin']);
const readSource = (value) => (SIGNATURE_SOURCES.has(value) ? value : 'submitted_form');

// The signature endpoints are self-service, so they must resolve the subject to a
// real volunteer before reading or writing. They used to trust req.user.id
// blindly, which assumed every authenticated token subject was a workers.id: CRM
// accounts live in `users`/`hrs`, so any of them could reach these routes, and
// the day those id spaces overlapped one account would have read or overwritten
// another volunteer's legal signature. Returns the worker id, or null after
// having already sent the response.
const resolveSignatureSubject = async (req, res) => {
  const subject = req.user?.id;
  if (!subject) {
    res.status(401).json({ message: 'Not authenticated' });
    return null;
  }
  let worker = null;
  try {
    worker = await getWorkerById(subject);
  } catch {
    // getWorkerById throws PGRST116 when no row matches.
    worker = null;
  }
  if (!worker) {
    res.status(403).json({ message: 'Signatures are only available to volunteer accounts.' });
    return null;
  }
  return subject;
};

export const uploadWorkerSignature = async (req, res) => {
  try {
    const workerId = await resolveSignatureSubject(req, res);
    if (!workerId) return;
    const { signature_base64, mime_type, source, policy_id, commit, re_sign } = req.body;

    if (!signature_base64) {
      return res.status(400).json({ message: 'Signature data is required' });
    }

    // A signature that is not a draft is the legal record, so it is not
    // overwritten by an ordinary "save" — the client gets a clear 409 instead.
    // Anything with a stored image is treated as final unless it is explicitly a
    // draft. That covers signatures uploaded before migration 159, whose status
    // is NULL, so the lock holds even on a host where the migration has not been
    // applied yet — otherwise the guard would silently not exist there.
    //
    // re_sign is the explicit "Update signature" path chosen by the volunteer:
    // it replaces the stored image and re-stamps the record as signed. The old
    // image is kept in signature_previous_url so the prior version is still
    // recoverable, and the swap is re-signed (not a silent overwrite of history).
    const current = await getSignatureState(workerId);
    const wantsResign = re_sign === true || re_sign === 'true';
    const isLocked = current.signature_url && current.signature_status !== 'draft';
    if (isLocked && !wantsResign) {
      return res.status(409).json({
        message: 'Signature already recorded. Use "Update signature" to replace it.',
        signature_url: await presignSignatureUrl(current.signature_url),
        signature_status: current.signature_status,
        signature_signed_at: current.signature_signed_at,
        can_resign: true,
      });
    }

    const buffer = Buffer.from(signature_base64, 'base64');
    const contentType = mime_type || 'image/png';
    const signatureUrl = await uploadSignatureImage(workerId, buffer, contentType);
    // A re-sign of an already-signed record is treated as a final commit; a
    // normal save stays a draft until the form is submitted.
    const commitNow = commit === true || commit === 'true' || (wantsResign && isLocked);

    const saved = await saveSignatureRecord(workerId, {
      signature_url: signatureUrl,
      signature_status: commitNow ? 'signed' : 'draft',
      signature_signed_at: commitNow ? new Date().toISOString() : null,
      signature_ip: commitNow ? (req.ip || null) : null,
      signature_source: readSource(source),
      signature_policy_id: policy_id || null,
      // Preserve the displaced image path (re-sign only). saveSignatureRecord
      // ignores unknown keys; updateWorkerPersonalDetails stays the generic path.
      ...(wantsResign && current.signature_url ? { signature_previous_url: current.signature_url } : {}),
    });

    return res.json({
      message: commitNow ? 'Signature recorded' : 'Signature saved',
      // The form renders this straight back to the volunteer, so it is signed.
      // `signatureUrl` above is what was written to the column and stays the
      // plain object URL -- only the response carries a signature.
      signature_url: await presignSignatureUrl(signatureUrl),
      signature_status: saved?.signature_status ?? (commitNow ? 'signed' : 'draft'),
      signature_signed_at: saved?.signature_signed_at ?? null,
      resigned: Boolean(wantsResign && isLocked),
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ---- Worker: Commit a saved draft signature (final form submit) ----

export const commitWorkerSignature = async (req, res) => {
  try {
    const workerId = await resolveSignatureSubject(req, res);
    if (!workerId) return;
    const { source, policy_id } = req.body;

    const current = await getSignatureState(workerId);
    if (!current.signature_url) {
      return res.status(400).json({ message: 'No signature has been saved yet' });
    }
    if (current.signature_status === 'signed') {
      // Idempotent: a double submit must not move the signed date.
      return res.json({
        message: 'Signature already recorded',
        signature_url: await presignSignatureUrl(current.signature_url),
        signature_status: 'signed',
        signature_signed_at: current.signature_signed_at,
      });
    }

    const saved = await commitSignature(workerId, {
      signedAt: new Date().toISOString(),
      ip: req.ip || null,
      source: readSource(source),
      policyId: policy_id || null,
    });

    if (!saved) {
      return res.status(503).json({ message: 'Signature could not be locked. Please try again.' });
    }

    return res.json({
      message: 'Signature recorded',
      // saved.signature_url is the stored object URL. The column is left holding
      // that; the volunteer only ever needs to see the image, so the response
      // carries a short-lived signed URL.
      signature_url: await presignSignatureUrl(saved.signature_url),
      signature_status: saved.signature_status,
      signature_signed_at: saved.signature_signed_at,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ---- Worker: Read current signature + policies in one round-trip ----

export const getWorkerSignature = async (req, res) => {
  try {
    const workerId = await resolveSignatureSubject(req, res);
    if (!workerId) return;
    const [state, policies] = await Promise.all([
      getSignatureState(workerId),
      getActivePolicies(),
    ]);
    return res.json({
      ...state,
      // Signed for the form to render. state.signature_url is the stored object
      // URL and stays that way in the column; only the response is signed.
      signature_url: await presignSignatureUrl(state.signature_url),
      // NULL status on a stored image means "uploaded before migration 159".
      // Treat it as signed so an older volunteer is never asked to sign again.
      signature_status: state.signature_url && !state.signature_status ? 'signed' : state.signature_status,
      policies: policies || [],
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ---- Admin: Upload digital signature for a worker ----
//
// Deliberately exempt from the worker-side 409 lock: this is the escape hatch HR
// uses to replace a signature the volunteer can no longer change themselves.
export const uploadSignature = async (req, res) => {
  try {
    const workerId = req.params.workerId;
    const { signature_base64, mime_type, policy_id } = req.body;

    if (!signature_base64) {
      return res.status(400).json({ message: 'Signature data is required' });
    }

    const buffer = Buffer.from(signature_base64, 'base64');
    const contentType = mime_type || 'image/png';
    const signatureUrl = await uploadSignatureImage(workerId, buffer, contentType);

    const saved = await saveSignatureRecord(workerId, {
      signature_url: signatureUrl,
      signature_status: 'signed',
      signature_signed_at: new Date().toISOString(),
      signature_ip: req.ip || null,
      signature_source: 'admin',
      signature_policy_id: policy_id || null,
    });

    return res.json({
      message: 'Signature uploaded successfully',
      signature_url: await presignSignatureUrl(signatureUrl),
      signature_status: saved?.signature_status ?? 'signed',
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ---- Get Company Policies (worker-facing) ----

export const getPolicies = async (req, res) => {
  try {
    const policies = await getActivePolicies();
    return res.json(policies);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ---- Get full profile (for print form) ----

export const getProfileForPrint = async (req, res) => {
  try {
    const workerId = req.user.id;
    const profile = await getFullWorkerProfile(workerId);
    const policies = await getActivePolicies();

    return res.json({
      profile,
      policies,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ---- Admin: Policy CRUD ----

export const adminGetPolicies = async (req, res) => {
  try {
    const policies = await getAllPolicies();
    return res.json(policies);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const adminAddPolicy = async (req, res) => {
  try {
    const { title, content, sort_order } = req.body;
    if (!title || !content) {
      return res.status(400).json({ message: 'Title and content are required' });
    }
    const policy = await createPolicy({
      title,
      content,
      sort_order: sort_order || 0,
    });
    return res.status(201).json(policy);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const adminEditPolicy = async (req, res) => {
  try {
    const { title, content, sort_order, is_active } = req.body;
    const updates = {};
    if (title !== undefined) updates.title = title;
    if (content !== undefined) updates.content = content;
    if (sort_order !== undefined) updates.sort_order = sort_order;
    if (is_active !== undefined) updates.is_active = is_active;

    const policy = await updatePolicy(req.params.id, updates);
    return res.json(policy);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const adminRemovePolicy = async (req, res) => {
  try {
    const result = await deletePolicy(req.params.id);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
