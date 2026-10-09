import { Router } from 'express';
import {
  addTask,
  getTasks,
  getTask,
  getMyTasks,
  editTask,
  removeTask,
  updateTaskStatus,
} from '../controllers/taskController.js';
import { authenticateRole, authenticateWorker } from '../middleware/authMiddleware.js';

const router = Router();

const adminOrHrOrHo = authenticateRole('super_admin', 'admin', 'hr');

router.post('/', adminOrHrOrHo, addTask);
router.get('/', adminOrHrOrHo, getTasks);
router.get('/my-tasks', authenticateWorker, getMyTasks);
router.get('/:id', adminOrHrOrHo, getTask);
router.put('/:id', adminOrHrOrHo, editTask);
router.put('/status/:id', authenticateWorker, updateTaskStatus);
router.delete('/:id', authenticateRole('super_admin', 'admin'), removeTask);

export default router;
