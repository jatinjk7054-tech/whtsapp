import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();
const u = new URL(process.env.DATABASE_URL);
u.hostname = 'localhost';
u.port = '5434';
const c = new pg.Client({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });

await c.connect();

const totals = await c.query(`
  SELECT
    (SELECT count(*) FROM chat_conversations WHERE slug = 'community')  AS community_rooms,
    (SELECT count(*) FROM chat_conversations)                           AS conversations,
    (SELECT count(*) FROM chat_participants)                           AS participants,
    (SELECT count(*) FROM chat_participants WHERE can_post)            AS writers,
    (SELECT count(*) FROM chat_messages)                               AS messages
`);
console.log('totals:', totals.rows[0], '\n');

const byRole = await c.query(`
  SELECT role, can_post, count(*)::int AS n
  FROM chat_participants
  GROUP BY 1, 2
  ORDER BY 2 DESC, 3 DESC
`);
console.table(byRole.rows);

// A read-only role must never hold a DM row. Structurally guaranteed by the
// seeder only seeding kind='group', but assert it rather than assume.
const leaked = await c.query(`
  SELECT count(*)::int AS n
  FROM chat_participants p
  JOIN chat_conversations c ON c.id = p.conversation_id
  WHERE c.kind = 'direct'
`);
console.log('participants in DM rooms:', leaked.rows[0].n, leaked.rows[0].n === 0 ? '(ok)' : '(UNEXPECTED)');

await c.end();
