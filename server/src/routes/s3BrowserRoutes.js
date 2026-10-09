import { Router } from 'express';
import { requireAdminKey } from '../middleware/requireAdminKey.js';
import {
  listBuckets,
  listObjects,
  deleteObjects,
  deleteFolder,
  getObjectStream,
} from '../services/s3Browser.js';

// ---------------------------------------------------------------------------
// S3 browser endpoints for the db-viewer. Mounted at /api/s3.
//
// Guarded by ENV_ADMIN_KEY (x-admin-key), the same shared secret the env
// admin tool uses. Unlike the table browser, this one can delete production
// documents — selfies, Aadhaar scans, receipts — so it is worth a secret.
// ---------------------------------------------------------------------------
const router = Router();
router.use(requireAdminKey);

// Route handlers are thin: pass the request through, and let the service's own
// status/message shape come back so the UI can render one error path.
const wrap = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (err) {
    res.status(err && err.status ? err.status : 500).json({ message: err.message });
  }
};

router.get('/buckets', wrap(() => listBuckets()));

router.get('/objects', wrap((req) => listObjects({
  account: req.query.account,
  bucket: req.query.bucket,
  prefix: req.query.prefix,
  token: req.query.token,
  delimiter: req.query.delimiter,
})));

router.post('/objects/delete', wrap((req) => deleteObjects({
  account: req.body && req.body.account,
  bucket: req.body && req.body.bucket,
  keys: req.body && req.body.keys,
})));

router.post('/folder/delete', wrap((req) => deleteFolder({
  account: req.body && req.body.account,
  bucket: req.body && req.body.bucket,
  prefix: req.body && req.body.prefix,
})));

// Raw bytes, not JSON — this one streams and must not run through wrap().
router.get('/object', async (req, res) => {
  try {
    const o = await getObjectStream({
      account: req.query.account,
      bucket: req.query.bucket,
      key: req.query.key,
    });
    res.setHeader('Content-Type', o.contentType);
    if (o.contentLength != null) res.setHeader('Content-Length', String(o.contentLength));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // attachment (never inline) so a stray HTML/SVG key cannot execute in the
    // tab serving the viewer.
    const name = String(req.query.key).split('/').pop() || 'object';
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    // Same shape as serveReceiptFile: newer SDK builds hand back a Readable,
    // older ones only a byte-array transform.
    const body = o.body;
    if (body && typeof body.pipe === 'function') {
      body.on('error', (e) => { console.error(`[s3-browser] stream failed for ${req.query.key}: ${e.message}`); res.destroy(); });
      return body.pipe(res);
    }
    return res.send(Buffer.from(await body.transformToByteArray()));
  } catch (err) {
    res.status(err && err.status ? err.status : 500).json({ message: err.message });
  }
});

export default router;
