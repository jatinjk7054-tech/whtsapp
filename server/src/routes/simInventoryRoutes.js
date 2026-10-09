import { Router } from 'express';
import {
  addInventoryItem,
  listInventoryItems,
  getInventoryItem,
  editInventoryItem,
  removeInventoryItem,
  assignInventoryItem,
  updateStatus,
  deleteBulk,
  importInventoryItems,
} from '../controllers/simInventoryController.js';
import { authenticate } from '../middleware/authMiddleware.js';

const router = Router();

const ANY_AUTH = authenticate;

router.get('/', ANY_AUTH, listInventoryItems);
router.get('/:id', ANY_AUTH, getInventoryItem);

router.post('/', ANY_AUTH, addInventoryItem);
router.post('/import', ANY_AUTH, importInventoryItems);
router.post('/bulk', ANY_AUTH, deleteBulk);
router.post('/:id/assign', ANY_AUTH, assignInventoryItem);
router.post('/:id/status', ANY_AUTH, updateStatus);

router.put('/:id', ANY_AUTH, editInventoryItem);
router.delete('/:id', ANY_AUTH, removeInventoryItem);

export default router;
