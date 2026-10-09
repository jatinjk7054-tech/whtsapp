import { config as dotenv } from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import { getRDSCapacity } from '../src/services/rdsCapacity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv({ path: path.join(__dirname, '..', '.env') });

const r = await getRDSCapacity();
console.log(JSON.stringify(r, null, 2));
process.exit(r.ok ? 0 : 1);
