import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import db from '../config/db.js';
import {
  COMMUNITY_SLUG,
  getCommunityConversation,
  addParticipant,
  removeStaleParticipants,
  listCommunityCandidates,
} from '../models/chatModel.js';
import { isWriterRole } from '../middleware/chatAccess.js';

/**
 * Community Chat bootstrap (plan.md §3, §5).
 *
 * Creates the tables, seeds the single Community room, and re-syncs membership
 * from the `workers` table on every boot. That last part is deliberate: it means
 * a newly hired accounts user is admitted to the Community room on the next
 * restart with no migration and no manual step, and a deactivated user is
 * dropped, without the seeder needing to be told.
 *
 * Members are `workers` rows only - the eight panels all log in against that
 * table. `users` is the CRM side and has no Community page.
 *
 * It only ever writes into `kind='group'` rooms, so a read-only role is
 * structurally never a member of a DM.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(here, '../../migrations/151_chat.sql');

async function applyMigration() {
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  await db._pool.query(sql);
}

async function ensureConversation() {
  const existing = await getCommunityConversation();
  if (existing) return existing;
  const { rows } = await db._pool.query(
    `INSERT INTO chat_conversations (kind, slug, title, created_by)
     VALUES ('group', $1, 'Community', 'system')
     ON CONFLICT (slug) DO NOTHING
     RETURNING *`,
    [COMMUNITY_SLUG]
  );
  if (rows[0]) return rows[0];
  return getCommunityConversation();
}

/** One row per `workers` record, shaped like a chat participant. */
function toParticipant(w) {
  const email = w.email ? String(w.email).trim().toLowerCase() : null;
  return {
    // An explicit uid wins. Workers authenticate with login_id and carry no
    // email in their JWT, so `login:<id>` is their key (and must match
    // chatUidFor). The Super Admin is the exception: their JWT does carry
    // email, so chatUidFor derives `email:<address>` and the row has to agree,
    // or isParticipant() fails and the Super Admin cannot read the room they
    // moderate.
    uid: w.uid || `login:${w.id}`,
    subjectId: String(w.id),
    role: w.role,
    canPost: isWriterRole(w.role),
    name: w.name || w.login_id || `User ${w.id}`,
    email,
    ngoId: w.ngo_id,
  };
}

/**
 * The Super Admin is not in `workers` - they log in straight from ADMIN_EMAIL
 * (authController.js adminLogin/salaryLogin) with id 0. Only this file can read
 * .env, so this is the one place their participant row can be created. Without
 * it the Super Admin opens Community, gets "not available for your account",
 * and cannot see the room they moderate.
 */
function superAdminParticipant() {
  const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (!email) return null;
  return {
    uid: `email:${email}`,
    subjectId: '0',
    role: 'super_admin',
    canPost: true,
    name: 'Super Admin',
    email,
    ngoId: null,
  };
}

/**
 * Re-syncs the Community room's roster.
 *
 * Existing rows are updated in place (ON CONFLICT DO UPDATE) so a role change -
 * someone promoted to accounts, say - gains can_post without losing their
 * last_read cursor. Anyone no longer eligible is deleted, so a deactivated
 * employee cannot keep reading the room on a stale row.
 */
async function syncCommunityParticipants(conversationId) {
  const candidates = await listCommunityCandidates();
  const extra = superAdminParticipant();
  const all = extra ? [...candidates, { ...extra, id: '0' }] : candidates;

  for (const w of all) {
    await addParticipant(conversationId, toParticipant(w));
  }

  const dropped = await removeStaleParticipants(
    conversationId,
    all.map((w) => w.uid || `login:${w.id}`)
  );
  return { seated: all.length, dropped: dropped.length };
}

export async function ensureChatSchema() {
  try {
    await applyMigration();
    const convo = await ensureConversation();
    const { seated, dropped } = await syncCommunityParticipants(convo.id);
    const note = dropped ? `, dropped ${dropped} stale` : '';
    console.log(`chat schema ready; community room "${convo.slug}" has ${seated} participants${note}`);
  } catch (e) {
    // A chat failure must not stop the rest of the API from booting.
    console.warn('[chat schema] skip:', e?.message || String(e));
  }
}
