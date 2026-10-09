// Shared guard for the endpoints that can read or destroy production documents:
// the S3 browser and the stored-file proxy the table browser uses for image
// previews. ENV_ADMIN_KEY is the same secret envAdminRoutes.js uses; when it is
// unset the guard passes through, which callers warn about on boot.
const ADMIN_KEY = process.env.ENV_ADMIN_KEY;

if (!ADMIN_KEY) {
  console.warn('WARNING: ENV_ADMIN_KEY is not set. S3 browser and stored-file endpoints are OPEN.');
}

export const requireAdminKey = (req, res, next) => {
  if (!ADMIN_KEY) return next();
  const key = req.headers['x-admin-key'] || req.query.key;
  if (key !== ADMIN_KEY) {
    return res.status(401).json({ message: 'Unauthorized — admin key required' });
  }
  next();
};
