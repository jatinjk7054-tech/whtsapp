import { HttpError } from '../lib/HttpError.js';
import { verifyToken } from '../lib/jwt.js';
import { getStaffById } from '../staff/staff.repository.js';

function readBearerToken(req) {
  const header = req.get('authorization') ?? '';
  const [scheme, token] = header.split(' ');

  if (scheme?.toLowerCase() !== 'bearer' || !token) return null;
  return token.trim();
}

export async function authenticate(req, res, next) {
  const token = readBearerToken(req);

  if (!token) {
    return next(new HttpError(401, 'Missing bearer token'));
  }

  let payload;

  try {
    payload = verifyToken(token);
  } catch {
    return next(new HttpError(401, 'Invalid or expired token'));
  }

  // Re-read the staff row: a deactivated or deleted account must lose access
  // immediately, not whenever its token happens to expire.
  const staff = await getStaffById(payload.sub);

  if (!staff || !staff.is_active) {
    return next(new HttpError(401, 'Account is not active'));
  }

  req.staff = staff;
  return next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.staff) {
      return next(new HttpError(401, 'Missing bearer token'));
    }
    if (!roles.includes(req.staff.role)) {
      return next(new HttpError(403, 'Insufficient role'));
    }
    return next();
  };
}