import crypto from 'crypto';
import { createQRCode, getAllQRCodes, getQRByCode, deleteQRCode } from '../models/qrModel.js';
import { haversineDistance } from '../utils/geo.js';

export const generateQR = async (req, res) => {
  try {
    const { label, latitude, longitude, radius_meters } = req.body;
    if (!label || latitude === undefined || longitude === undefined) {
      return res.status(400).json({ message: 'Label, latitude, and longitude are required' });
    }
    const code = crypto.randomUUID();
    const qr = await createQRCode({
      code,
      label,
      latitude,
      longitude,
      radius_meters: radius_meters || 100,
    });
    const qrData = JSON.stringify({ code: qr.code, lat: qr.latitude, lng: qr.longitude });
    return res.status(201).json({ message: 'QR code generated', qr, qrData });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const listQRCodes = async (req, res) => {
  try {
    const codes = await getAllQRCodes();
    return res.json(codes);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const removeQRCode = async (req, res) => {
  try {
    const result = await deleteQRCode(req.params.id);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const validateQRAndLocation = async (req, res) => {
  try {
    const { code, latitude, longitude } = req.body;
    if (!code || latitude === undefined || longitude === undefined) {
      return res.status(400).json({ message: 'Code, latitude, and longitude are required' });
    }
    const qr = await getQRByCode(code);
    if (!qr) {
      return res.status(404).json({ message: 'Invalid QR code' });
    }
    const distance = haversineDistance(qr.latitude, qr.longitude, latitude, longitude);
    if (distance > qr.radius_meters) {
      return res.status(403).json({
        message: `You are outside the allowed range. Distance: ${Math.round(distance)}m (max: ${qr.radius_meters}m)`,
        distance: Math.round(distance),
        maxDistance: qr.radius_meters,
      });
    }
    return res.json({ message: 'Location verified', distance: Math.round(distance), qr });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
