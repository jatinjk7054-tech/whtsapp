import { Router } from 'express';
import { generateQuiz, submitQuiz, listResults, getResult } from '../controllers/quizController.js';
import { authenticateRole } from '../middleware/authMiddleware.js';

const router = Router();

// Public: candidates use these from the recruit-quizz app.
router.post('/generate', generateQuiz);
router.post('/submit', submitQuiz);

// HR / recruiters / admins view the results board.
const canView = authenticateRole('super_admin', 'admin', 'hr', 'recruiter');
router.get('/results', canView, listResults);
router.get('/results/:id', canView, getResult);

export default router;
