import { Router } from 'express';
import { authenticateRole } from '../middleware/authMiddleware.js';
import { deviceImport, status, runs, runDetail, ngos, knownRefs, sources } from '../controllers/scraperController.js';

const router = Router();

// ---- Device app endpoints (the scrapper/ Android app) — keyed by
//       SCRAPER_DEVICE_KEY so the app can post without a user login. ----
const SCRAPER_DEVICE_KEY = process.env.SCRAPER_DEVICE_KEY;
const requireDeviceKey = (req, res, next) => {
  if (!SCRAPER_DEVICE_KEY) {
    return res.status(503).json({ message: 'Scraper device endpoints not configured (SCRAPER_DEVICE_KEY)' });
  }
  if (req.headers['x-scraper-key'] !== SCRAPER_DEVICE_KEY) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  next();
};

router.post('/device-import', requireDeviceKey, deviceImport);
router.get('/known-refs', requireDeviceKey, knownRefs);
router.get('/ngos', requireDeviceKey, ngos);
router.get('/sources', requireDeviceKey, sources);

// ---- Accounts panel endpoints ----
router.get('/status', authenticateRole('accounts', 'super_admin'), status);
router.get('/runs', authenticateRole('accounts', 'super_admin'), runs);
router.get('/runs/:runId', authenticateRole('accounts', 'super_admin'), runDetail);

export default router;