import { Router } from 'express';
import { authenticate, authenticateRole, authenticateAccountsOrEventTeam } from '../middleware/authMiddleware.js';
import {
  listTickets, listMyTickets, getTicket, createTicket, updateTicket, addReply, deleteTicket, getWorkers
} from '../controllers/ticketController.js';

const router = Router();

router.use(authenticate);

router.get('/workers', getWorkers);
router.get('/my', listMyTickets);

router.post('/', createTicket);
// Accounts/super admin list everything; the Event Manager team lists the same
// endpoint but the UI only ever asks for its own department + category.
router.get('/', authenticateAccountsOrEventTeam, listTickets);
router.get('/:id', getTicket);
router.put('/:id', authenticateAccountsOrEventTeam, updateTicket);
router.delete('/:id', authenticateRole('accounts', 'super_admin'), deleteTicket);
router.post('/:id/reply', addReply);

export default router;
