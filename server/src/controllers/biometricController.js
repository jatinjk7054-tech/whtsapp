import { enrollBiometric, getBiometrics, getBiometricStatus, identifyBeneficiaryByTemplate, listEnrolledTemplates, revokeBiometric, verifyBiometric } from '../models/biometricModel.js';
import { logAuditEvent } from '../models/auditLogModel.js';
import { createHash } from 'crypto';

export const enrollFingerprint = async (req, res) => {
  try {
    const {
      beneficiary_id, beneficiary_code, finger_position, quality, device_id,
      credential_reference, provider, device_type, device_name, pid_data, fid_data, template,
      quality_score, template_data, image_b64, template_b64, width, height, dpi,
    } = req.body;

    // Resolve beneficiary: accept either beneficiary_id or beneficiary_code
    let resolvedBeneficiaryId = beneficiary_id;
    if (!resolvedBeneficiaryId && beneficiary_code) {
      const { default: db } = await import('../config/db.js');
      const { data: bnf } = await db
        .from('beneficiaries')
        .select('id')
        .eq('beneficiary_code', beneficiary_code)
        .single();
      resolvedBeneficiaryId = bnf?.id;
    }

    if (!resolvedBeneficiaryId) {
      return res.status(400).json({ message: 'beneficiary_id (or code) is required' });
    }

    const resolvedFingerPosition = finger_position || 'UNKNOWN';

    // Resolve how the credential is stored.
    // 1. Own-system raw capture: structured image + template fields -> JSON payload.
    // 2. Pre-built structured JSON passed through by the client.
    // 3. Legacy vendor PID/FID blob (unchanged behavior).
    let storedTemplateData = null;
    let storedTemplateFormat = null;
    let reference = credential_reference || null;

    if (image_b64 || template_b64) {
      storedTemplateData = JSON.stringify({
        version: 1,
        format: 'raw',
        image: image_b64 || null,
        template: template_b64 || null,
        width: width || null,
        height: height || null,
        dpi: dpi || null,
        finger: resolvedFingerPosition,
      });
      storedTemplateFormat = 'raw';
      if (template_b64) {
        reference = reference || createHash('sha256').update(template_b64).digest('hex');
      }
    } else if (typeof template_data === 'string' && template_data.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(template_data);
        storedTemplateData = template_data;
        storedTemplateFormat = parsed.format === 'raw' ? 'raw' : 'json';
        if (parsed.template) {
          reference = reference || createHash('sha256').update(String(parsed.template)).digest('hex');
        }
      } catch {
        storedTemplateData = null;
        storedTemplateFormat = null;
      }
    } else {
      storedTemplateData = template || fid_data || null;
      storedTemplateFormat = storedTemplateData ? 'legacy' : null;
    }

    const metadata =
      storedTemplateFormat === 'raw'
        ? { width: width || null, height: height || null, dpi: dpi || null, finger: resolvedFingerPosition }
        : width || height || dpi
          ? { width: width || null, height: height || null, dpi: dpi || null, finger: resolvedFingerPosition }
          : null;

    const result = await enrollBiometric({
      beneficiary_id: resolvedBeneficiaryId,
      provider: provider || device_type || 'generic',
      device_type: device_type || null,
      device_name: device_name || null,
      device_id: device_id || null,
      credential_reference: reference || fid_data || template || null,
      template_data: storedTemplateData,
      template_format: storedTemplateFormat,
      template_metadata: metadata,
      finger_position: resolvedFingerPosition,
      quality_score: quality_score || quality || 'GOOD',
      status: 'ENROLLED',
      enrolled_by: req.user?.name || 'system',
    });

    await logAuditEvent({
      entity_type: 'biometric', entity_id: result.id,
      beneficiary_id: resolvedBeneficiaryId, action: 'BIOMETRIC_ENROLLED',
      details: { finger_position: resolvedFingerPosition, quality, device_type, device_name, template_format: storedTemplateFormat },
      performed_by: req.user?.name || 'system',
    });

    return res.status(201).json({ message: 'Fingerprint enrolled', credential: result });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const verifyFingerprint = async (req, res) => {
  try {
    const { beneficiary_id, beneficiary_code, finger_position, template_data } = req.body;

    let resolvedBeneficiaryId = beneficiary_id;
    if (!resolvedBeneficiaryId && beneficiary_code) {
      const { default: db } = await import('../config/db.js');
      const { data: bnf } = await db
        .from('beneficiaries')
        .select('id')
        .eq('beneficiary_code', beneficiary_code)
        .single();
      resolvedBeneficiaryId = bnf?.id;
    }

    const result = await verifyBiometric(resolvedBeneficiaryId, finger_position, template_data);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getBiometricDetails = async (req, res) => {
  try {
    const status = await getBiometricStatus(req.params.id);
    return res.json(status);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const revokeFingerprint = async (req, res) => {
  try {
    const result = await revokeBiometric(req.params.id);

    await logAuditEvent({
      entity_type: 'biometric', entity_id: result.id,
      beneficiary_id: result.beneficiary_id, action: 'BIOMETRIC_REVOKED',
      performed_by: req.user?.name || 'system',
    });

    return res.json({ message: 'Credential revoked', credential: result });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const identifyFingerprint = async (req, res) => {
  try {
    const template = req.body.template || req.body.fid_data || null;
    if (!template) return res.status(400).json({ message: 'Fingerprint template is required' });

    const beneficiary = await identifyBeneficiaryByTemplate(template);
    if (!beneficiary) return res.status(404).json({ message: 'No beneficiary matched this fingerprint' });

    return res.json({ beneficiary });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const listFingerprintTemplates = async (req, res) => {
  try {
    const templates = await listEnrolledTemplates();
    return res.json({ templates });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
