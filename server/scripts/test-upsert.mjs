import { config as dotenv } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv({ path: path.join(__dirname, '..', '.env') });
import db from '../src/config/db.js';

const MOBILE = '0000000009';
try {
  const pre = await db.from('donor_profiles').select('id').eq('mobile_number', MOBILE);
  console.log('pre-existing:', JSON.stringify(pre.data?.length));

  const { data: ins, error: e1 } = await db.from('donor_profiles')
    .upsert([{ mobile_number: MOBILE, name: 'ZZ Test', address_1: 'Test Addr' }],
      { onConflict: 'mobile_number', ignoreDuplicates: true })
    .select('id, name');
  console.log('insert result:', JSON.stringify(ins), e1 ? `ERR ${e1.message}` : '');

  const { data: dup } = await db.from('donor_profiles')
    .upsert([{ mobile_number: MOBILE, name: 'ZZ Test2' }],
      { onConflict: 'mobile_number', ignoreDuplicates: true })
    .select('id, name');
  console.log('dup ignored:', JSON.stringify(dup));

  await db.from('donor_profiles').delete().eq('mobile_number', MOBILE);
  console.log('cleaned up');
  process.exit(0);
} catch (e) {
  console.error('FAIL:', e.message);
  try { await db.from('donor_profiles').delete().eq('mobile_number', MOBILE); } catch {}
  process.exit(1);
}
