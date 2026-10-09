const {Pool}=require('pg');
const p=new Pool({connectionString:'postgres://ucs_app:xm4BAoZRhOVU3NFW2qLe@localhost:5434/postgres',ssl:{rejectUnauthorized:false}});
(async()=>{
  const nd=await p.query("SELECT ngo_id, name FROM ngos WHERE name IN ('BSCT','AFLF','MANN')");
  const nameMap={}; for(const r of nd.rows) nameMap[r.ngo_id]=r.name;
  console.log('ngo map:', nameMap);
  const fa=await p.query("SELECT station, ngo_id, COUNT(DISTINCT donor_id) as cnt FROM fro_assignments WHERE station IS NOT NULL AND status!='reassigned' GROUP BY station, ngo_id ORDER BY station, ngo_id");
  const byStation={};
  for(const r of fa.rows){
    if(!byStation[r.station]) byStation[r.station]={};
    byStation[r.station][r.ngo_id]=r.cnt;
  }
  for(const [s,ngos] of Object.entries(byStation)){
    const parts=Object.entries(ngos).map(([nid,cnt])=>`${nameMap[nid]||nid}:${cnt}`).join(', ');
    console.log(s, parts);
  }
  await p.end();
})().catch(e=>console.error(e.message));