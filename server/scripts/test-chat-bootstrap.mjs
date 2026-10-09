import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();
const u = new URL(process.env.DATABASE_URL);
u.hostname = 'localhost';
u.port = '5434';

// Point the app's own pool at the tunnel before anything imports it.
process.env.DATABASE_URL = u.toString();

const { default: db } = await import('../src/config/db.js');
const { ensureChatSchema } = await import('../src/bootstrap/ensureChatSchema.js');

const c = new pg.Client({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
await c.connect();

const convo = await c.query(`SELECT id FROM chat_conversations WHERE slug='community'`);
const roomId = convo.rows[0].id;

// Plant a stale row: a person who is no longer staff. Before the fix this
// survived every boot and kept passing isParticipant().
await c.query(
  `INSERT INTO chat_participants (conversation_id, uid, subject_id, role, can_post, display_name)
   VALUES ($1, 'login:stale-gone', 'stale-gone', 'accounts', true, 'Stale Person')
   ON CONFLICT (conversation_id, uid) DO UPDATE SET can_post = true`,
  [roomId]
);
const before = await c.query(`SELECT count(*)::int AS n FROM chat_participants WHERE conversation_id=$1`, [roomId]);
console.log('before boot:', before.rows[0].n, 'participants (1 planted stale row)');

console.log('\n--- ensureChatSchema() ---');
await ensureChatSchema();

const after = await c.query(`SELECT count(*)::int AS n FROM chat_participants WHERE conversation_id=$1`, [roomId]);
console.log('\nafter boot:', after.rows[0].n, 'participants');

const stale = await c.query(
  `SELECT count(*)::int AS n FROM chat_participants WHERE conversation_id=$1 AND uid='login:stale-gone'`,
  [roomId]
);
console.log('stale row still present?', stale.rows[0].n > 0 ? 'YES - bug' : 'no - correctly dropped');

const sa = await c.query(
  `SELECT uid, subject_id, role, can_post, display_name FROM chat_participants
   WHERE conversation_id=$1 AND subject_id='0'`,
  [roomId]
);
console.log('\nsuper admin row:', sa.rows[0] || 'MISSING');

const writers = await c.query(
  `SELECT uid, display_name, role FROM chat_participants WHERE conversation_id=$1 AND can_post ORDER BY 2`,
  [roomId]
);
console.log('\nwriters:');
console.table(writers.rows);

await c.end();
await db._pool.end();
process.exit(0);
