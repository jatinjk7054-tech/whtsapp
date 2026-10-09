import { Router } from 'express';
import { addDataSource, listDataSources, getDataSource, editDataSource, removeDataSource, toggleDataSource } from '../controllers/dataSourceController.js';
import { authenticateRole } from '../middleware/authMiddleware.js';

const router = Router();

router.get('/', authenticateRole('super_admin'), listDataSources);
router.post('/', authenticateRole('super_admin'), addDataSource);
router.get('/:id', authenticateRole('super_admin'), getDataSource);
router.put('/:id', authenticateRole('super_admin'), editDataSource);
router.delete('/:id', authenticateRole('super_admin'), removeDataSource);
router.put('/:id/toggle', authenticateRole('super_admin'), toggleDataSource);

export default router;
