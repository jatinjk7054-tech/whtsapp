import { config as dotenv } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import jwt from 'jsonwebtoken';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv({ path: path.join(__dirname, '..', '.env') });

const token = jwt.sign({ id: 'seed-assets', email: 'seed-assets@local', role: 'accounts' }, process.env.JWT_SECRET, { expiresIn: '1h' });

const probes = [
  { cat: 'Nokia Mobile', name: 'Nokia Mobile', loc: 'AFLF Cabin', qty: 41 },
  { cat: 'Nokia Mobile', name: 'Nokia Mobile', loc: 'BPO Cabin', qty: 11 },
  { cat: 'Android Mobile', name: 'Android Mobile', loc: 'BPO Cabin', qty: 4 },
  { cat: 'Android Mobile', name: 'Admin Department', loc: 'MANN Cabin', qty: 3 },
  { cat: 'Android Mobile', name: 'Social Media Department (I Phone and AFLF)', loc: 'MANN Cabin', qty: 2 },
];

for (const p of probes) {
  const row = {
    code: '',
    name: p.name,
    category: p.cat,
    location: p.loc,
    team_leader: '',
    quantity: p.qty,
    remarks: '',
    status: 'available',
  };
  const res = await fetch('https://api.beingsevak.org/api/assets/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ rows: [row] }),
  });
  const body = await res.json();
  console.log(`${p.cat.padEnd(14)} @ ${p.loc.padEnd(14)} qty=${p.qty} -> HTTP ${res.status} | inserted=${body.inserted} skipped=${JSON.stringify(body.skipped)} errors=${JSON.stringify(body.errors)}`);
}