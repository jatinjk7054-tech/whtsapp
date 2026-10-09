import { config as dotenv } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import jwt from 'jsonwebtoken';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv({ path: path.join(__dirname, '..', '.env') });

const token = jwt.sign({ id: 'seed-assets', email: 'seed-assets@local', role: 'accounts' }, process.env.JWT_SECRET, { expiresIn: '1h' });
const res = await fetch('https://api.beingsevak.org/api/assets', { headers: { Authorization: `Bearer ${token}` } });
const assets = await res.json();

console.log('status', res.status, 'rows', assets.length);
for (const a of assets) {
  console.log(`${String(a.id).padEnd(6)} | code=${String(a.code || '').padEnd(14)} | ${String(a.category || '').padEnd(16)} | ${String(a.name || '').padEnd(34)} | loc=${String(a.location || '').padEnd(18)} | qty=${a.quantity || 1} | status=${a.status || ''} | ${String(a.remarks || '').slice(0, 30)}`);
}