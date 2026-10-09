import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();
const u = new URL(process.env.DATABASE_URL);
u.hostname = 'localhost';
u.port = '5434';
const c = new pg.Client({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
await c.connect();

const msgs = await c.query(
  `DELETE FROM chat_messages
   WHERE body IN ('e2e hello', 'e2e edited', 'dm hi', 'hijack', 'nope')
      OR client_id = 'e2e-1'`
);
console.log('cleared test messages:', msgs.rowCount);

const dms = await c.query(
  `DELETE FROM chat_conversations c
   WHERE c.kind = 'direct'
     AND NOT EXISTS (SELECT 1 FROM chat_messages m WHERE m.conversation_id = c.id)`
);
console.log('cleared empty test DMs:', dms.rowCount);

const left = await c.query(
  `SELECT (SELECT count(*) FROM chat_messages)::int AS messages,
          (SELECT count(*) FROM chat_participants)::int AS participants,
          (SELECT count(*) FROM chat_participants WHERE can_post)::int AS writers`
);
console.log('state now:', left.rows[0]);

await c.end();
