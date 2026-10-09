import { config as dotenv } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv({ path: path.join(__dirname, '..', '.env') });
import db from '../src/config/db.js';
import { importDonorAddresses } from '../src/controllers/accountsController.js';

const NEW_MOBILE = '0000000099';
const EXISTING_MOBILE = '9820012345'; // may or may not exist; use a real one below if not

// find any real donor to test update path
const { data: anyDonor } = await db.from('donor_profiles').select('id, mobile_number, name, email').limit(1);
const existingMobile = anyDonor?.[0]?.mobile_number;
console.log('using existing donor mobile:', existingMobile);

const req = { body: { rows: [
  { mobile_number: existingMobile, name: '', address_1: '', address_2: '', pan_number: '', email: '' },
  { mobile_number: NEW_MOBILE, name: 'ZZ New Donor', address_1: '12 Test Lane', address_2: 'Mumbai', pan_number: 'ABCDE1234F', email: 'zz@test.com' },
  { mobile_number: NEW_MOBILE, name: 'Dup Row', address_1: '', address_2: '', pan_number: '', email: '' },
  { mobile_number: '123', name: 'Bad', address_1: '', address_2: '', pan_number: '', email: '' },
]}};
let jsonPayload = null; let statusCode = null;
const res = {
  status(code) { statusCode = code; return this; },
  json(obj) { jsonPayload = obj; return this; },
};

await importDonorAddresses(req, res);
console.log('status:', statusCode);
console.log('summary:', JSON.stringify(jsonPayload?.summary));
for (const r of jsonPayload?.results || []) console.log(' ', JSON.stringify(r));

const check = await db.from('donor_profiles')
  .select('mobile_number, name, address_1, address_2, pan_number, email')
  .eq('mobile_number', NEW_MOBILE).maybeSingle();
console.log('\nnew donor in DB:', JSON.stringify(check.data));

await db.from('donor_profiles').delete().eq('mobile_number', NEW_MOBILE);
console.log('cleaned up');
process.exit(0);
