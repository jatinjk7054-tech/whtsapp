import { Router } from 'express';
import db from '../config/db.js';
import { authenticateRole } from '../middleware/authMiddleware.js';

const router = Router();

router.get('/', authenticateRole('super_admin', 'admin', 'hr', 'accounts', 'recruiter', 'leads', 'telecaller', 'team_lead'), async (req, res) => {
  try {
    const { year, month } = req.query;
    const y = parseInt(year) || new Date().getFullYear();
    const m = parseInt(month) || (new Date().getMonth() + 1);
    const mStr = String(m).padStart(2, '0');

    const fromDate = `${y}-${mStr}-01`;
    const lastDay = new Date(y, m, 0).getDate();
    const toDate = `${y}-${mStr}-${String(lastDay).padStart(2, '0')}`;

    const ngoId = req.user.role === 'super_admin' ? req.query.ngo_id : req.user.ngo_id;

    let eventsQuery = db.from('events').select('*')
      .gte('event_date', fromDate).lte('event_date', toDate)
      .eq('is_active', true);

    let holidaysQuery = db.from('holidays').select('*');

    let workersQuery = db.from('workers').select('id, name, dob');

    if (ngoId) {
      eventsQuery = eventsQuery.eq('ngo_id', ngoId);
      holidaysQuery = holidaysQuery.eq('ngo_id', ngoId);
      workersQuery = workersQuery.eq('ngo_id', ngoId);
    }

    eventsQuery = eventsQuery.order('event_date', { ascending: true });
    holidaysQuery = holidaysQuery.order('date', { ascending: true });

    const [eventsRes, holidaysRes, workersRes] = await Promise.all([
      eventsQuery, holidaysQuery, workersQuery,
    ]);

    const events = (eventsRes.data || []).map(e => ({
      id: e.id,
      title: e.title,
      date: e.event_date,
      type: 'event',
      description: e.description,
      time: e.event_time,
      location: e.location,
    }));

    const holidays = (holidaysRes.data || [])
      .filter(h => {
        const d = new Date(h.date + 'T00:00:00');
        if (h.is_recurring) return d.getMonth() + 1 === m;
        return d.getFullYear() === y && d.getMonth() + 1 === m;
      })
      .map(h => ({
        id: h.id,
        name: h.name,
        date: h.date,
        type: 'holiday',
        is_recurring: h.is_recurring,
      }));

    const birthdays = (workersRes.data || [])
      .filter(w => w.dob)
      .map(w => {
        const d = new Date(w.dob + 'T00:00:00');
        return { ...w, _m: d.getMonth() + 1, _d: d.getDate() };
      })
      .filter(w => w._m === m)
      .map(w => ({
        id: w.id,
        name: w.name,
        date: `${y}-${String(w._m).padStart(2, '0')}-${String(w._d).padStart(2, '0')}`,
        type: 'birthday',
      }));

    return res.json({ events, holidays, birthdays });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

export default router;
