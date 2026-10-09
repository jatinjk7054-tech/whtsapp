import { createNgo, getAllNgos, getNgoById, updateNgo, deleteNgo } from '../models/ngoModel.js';
import { getAllUsers } from '../models/userModel.js';
import db from '../config/db.js';

export const getNgoSummary = async (req, res) => {
  try {
    const ngos = await getAllNgos();
    const monthFirst = () => {
      const now = new Date();
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    };

    const { data: people, error: pErr } = await db
      .from('worker_people_allocations')
      .select('worker_id, ngo_id, allocation_percentage');
    if (pErr) throw pErr;

    const { data: workers, error: wErr } = await db
      .from('workers')
      .select('id, ngo_id')
      .eq('is_active', true)
      .eq('is_test', false);
    if (wErr) throw wErr;

    const { data: salary, error: sErr } = await db
      .from('salary_allocations')
      .select('ngo_id, allocation_amount')
      .eq('salary_month', monthFirst());
    if (sErr) throw sErr;

    const countBy = (rows, field) => {
      const m = {};
      for (const r of rows || []) m[r[field]] = (m[r[field]] || 0) + 1;
      return m;
    };
    const amtBy = (rows, field) => {
      const m = {};
      for (const r of rows || []) m[r[field]] = (m[r[field]] || 0) + (parseFloat(r.allocation_amount) || 0);
      return m;
    };
    const pctBy = (rows, field) => {
      const m = {};
      for (const r of rows || []) m[r[field]] = (m[r[field]] || 0) + (parseFloat(r.allocation_percentage) || 0);
      return m;
    };

    const peopleCount = countBy(people, 'ngo_id');
    const salaryCount = countBy(salary, 'ngo_id');
    const salaryAmt = amtBy(salary, 'ngo_id');
    const peoplePct = pctBy(people, 'ngo_id');

    // Volunteers = distinct active workers linked to the NGO, either via their
    // primary ngo_id (set automatically when the member is added) or via a
    // manual people-allocation row.
    const volSets = {};
    const addVol = (ngoId, workerId) => {
      if (ngoId == null || workerId == null) return;
      (volSets[ngoId] = volSets[ngoId] || new Set()).add(workerId);
    };
    for (const w of workers || []) addVol(w.ngo_id, w.id);
    for (const p of people || []) addVol(p.ngo_id, p.worker_id);

    return res.json(
      ngos.map((ngo) => ({
        ...ngo,
        volunteers: volSets[ngo.id] ? volSets[ngo.id].size : (peopleCount[ngo.id] || 0),
        allocation_percentage: Math.round((peoplePct[ngo.id] || 0) * 100) / 100,
        salary_employees: salaryCount[ngo.id] || 0,
        salary_amount: Math.round((salaryAmt[ngo.id] || 0) * 100) / 100,
      }))
    );
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Total beneficiaries (members) recorded under each NGO. Serves the NGO cards
// on the Beneficiaries app home "kit" section — one card per NGO with its
// member count.
export const getNgoMemberCounts = async (req, res) => {
  try {
    const { rows } = await db._pool.query(`
      SELECT n.id, n.name, n.code,
             (SELECT COUNT(*) FROM beneficiaries b WHERE b.ngo_id = n.id)::int AS member_count,
             (SELECT COALESCE(SUM(r.amount), 0) FROM receipts r
               WHERE r.receipt_no IS NOT NULL AND lower(r.project_id) = lower(n.name))::float8 AS donated
        FROM ngos n
       ORDER BY n.name ASC
    `);
    return res.json(rows.map((r) => ({
      id: r.id, name: r.name, code: r.code,
      member_count: r.member_count || 0,
      donated: parseFloat(r.donated) || 0,
    })));
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const addNgo = async (req, res) => {
  try {
    const { name, code, address, registration_no } = req.body;
    if (!name || !code) {
      return res.status(400).json({ message: 'Name and code are required' });
    }
    const ngo = await createNgo({ name, code: code.toUpperCase(), address, registration_no });
    return res.status(201).json({ message: 'NGO created successfully', ngo });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Lightweight NGO list for the Beneficiaries app operator dropdown — only the
// options the worker actually needs (id, name, code), no user aggregation.
export const listNgoOptions = async (req, res) => {
  try {
    const ngos = await getAllNgos();
    return res.json(
      ngos.map(({ id, name, code }) => ({ id, name, code }))
    );
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const listNgos = async (req, res) => {
  try {
    const ngos = await getAllNgos();
    const enriched = await Promise.all(
      ngos.map(async (ngo) => {
        const users = await getAllUsers({ ngo_id: ngo.id });
        const userCounts = {};
        users.forEach((u) => {
          userCounts[u.role] = (userCounts[u.role] || 0) + 1;
        });
        return { ...ngo, userCounts, totalUsers: users.length };
      })
    );
    return res.json(enriched);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getNgo = async (req, res) => {
  try {
    const ngo = await getNgoById(req.params.id);
    if (!ngo) return res.status(404).json({ message: 'NGO not found' });
    const users = await getAllUsers({ ngo_id: ngo.id });
    return res.json({ ...ngo, users });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const editNgo = async (req, res) => {
  try {
    const { name, code, address, registration_no, is_active } = req.body;
    const updates = {};
    if (name) updates.name = name;
    if (code) updates.code = code.toUpperCase();
    if (address !== undefined) updates.address = address;
    if (registration_no !== undefined) updates.registration_no = registration_no;
    if (is_active !== undefined) updates.is_active = is_active;
    const ngo = await updateNgo(req.params.id, updates);
    return res.json({ message: 'NGO updated successfully', ngo });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const removeNgo = async (req, res) => {
  try {
    const result = await deleteNgo(req.params.id);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const toggleNgo = async (req, res) => {
  try {
    const ngo = await getNgoById(req.params.id);
    if (!ngo) return res.status(404).json({ message: 'NGO not found' });
    const updated = await updateNgo(req.params.id, { is_active: !ngo.is_active });
    return res.json({ message: `NGO ${updated.is_active ? 'activated' : 'deactivated'} successfully`, ngo: updated });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
