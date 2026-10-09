import { Router } from 'express';
import { authenticateRole } from '../middleware/authMiddleware.js';
import {
  decodeAadhaarQr,
  AadhaarDecodeError,
  buildFailureDetail,
} from './decoder.js';

const router = Router();

// POST /api/aadhaar/decode-qr
// Body: { "qrData": "<raw QR payload>" }
// Decodes an Aadhaar QR (SecureQR via @xone-labs/aadharjs, legacy XML via the
// existing XML decoder) and returns the fields needed to auto-fill the
// beneficiary registration form. Raw QR values / decoded data are never
// logged or persisted here.
router.post(
  '/decode-qr',
  authenticateRole('super_admin', 'admin', 'ngo', 'accounts', 'event_head', 'worker'),
  (req, res) => {
    const qrData = req.body?.qrData;
    if (qrData == null || String(qrData).trim() === '') {
      return res.status(400).json({ success: false, message: 'QR data is required' });
    }

    try {
      const data = decodeAadhaarQr(qrData);
      return res.json({ success: true, data });
    } catch (error) {
      if (error instanceof AadhaarDecodeError) {
        const message =
          error.kind === 'unsupported'
            ? 'Unsupported Aadhaar QR format'
            : 'Invalid Aadhaar QR';
        const detail = buildFailureDetail(qrData, error.detail);
        // Metadata only (length / format flags / package error) — never the
        // raw payload or any decoded field values.
        console.warn(`[aadhaar] ${message}: ${detail}`);
        return res.status(400).json({ success: false, message, detail });
      }
      const detail = buildFailureDetail(qrData, {});
      console.warn(`[aadhaar] Unable to decode Aadhaar QR: ${detail}`);
      return res.status(500).json({ success: false, message: 'Unable to decode Aadhaar QR', detail });
    }
  },
);

export default router;