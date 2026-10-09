import { Router } from 'express';
import {
  addNotice,
  listNotices,
  getNotice,
  editNotice,
  removeNotice,
  markSeen,
} from '../controllers/noticeController.js';
import { authenticateRole, authenticate } from '../middleware/authMiddleware.js';

const router = Router();

const adminOrHr = authenticateRole('super_admin', 'admin', 'hr', 'master');

router.post('/', adminOrHr, addNotice);
router.get('/', authenticate, listNotices);
router.post('/:id/seen', authenticate, markSeen);
router.get('/:id', adminOrHr, getNotice);
router.put('/:id', adminOrHr, editNotice);
router.delete('/:id', authenticateRole('super_admin', 'admin', 'hr', 'master', 'fro', 'worker'), removeNotice);

export default router;
