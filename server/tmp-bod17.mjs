import db from './src/config/db.js';
const out = async (sql) => {
  try { return await db._pool.query(sql); } catch (e) { return { rows: [{ err: e.message }] }; }
};
const a = await out("SELECT DISTINCT station FROM fro_station_assignments WHERE station ILIKE '%-17%' LIMIT 30");
console.log('assignments:', JSON.stringify(a.rows));
const b = await out("SELECT DISTINCT station FROM donor_profiles WHERE station ILIKE '%-17%' LIMIT 30");
console.log('donors:', JSON.stringify(b.rows));
const c = await out("SELECT DISTINCT station FROM fro_station_assignments WHERE station ILIKE '%AOD%' LIMIT 30");
console.log('aod assignments:', JSON.stringify(c.rows));
const d = await out("SELECT DISTINCT station FROM donor_profiles WHERE station ILIKE '%AOD%' LIMIT 30");
console.log('aod donors:', JSON.stringify(d.rows));
process.exit(0);
