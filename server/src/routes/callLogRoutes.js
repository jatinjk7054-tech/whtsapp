import jwt from 'jsonwebtoken';
import { Router } from 'express';
import { addCallLog, listMyCallLogs, getLeadCallLogs, getSingleCallLog } from '../controllers/callLogController.js';

const router = Router();

const telecallerOrAbove = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'No token provided' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const allowedRoles = ['telecaller', 'hr', 'recruiter'];
    const isFroWorker = decoded.role === 'worker' && (decoded.department || '').toLowerCase().trim() === 'fro';
    if (!allowedRoles.includes(decoded.role) && !isFroWorker) {
      return res.status(403).json({ message: 'Access denied. Call logs require telecaller, hr, or recruiter role.' });
    }
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ message: 'Invalid token' });
  }
};

router.post('/', telecallerOrAbove, addCallLog);
router.get('/', telecallerOrAbove, listMyCallLogs);
router.get('/lead/:leadId', telecallerOrAbove, getLeadCallLogs);
router.get('/:id', telecallerOrAbove, getSingleCallLog);

export default router;
