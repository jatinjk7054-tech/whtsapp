import * as chat from '../src/models/chatModel.js';
import { readFileSync } from 'fs';

/**
 * Asserts the backend's wire shape against what client/src/components/chat
 * actually destructures. These seven mismatches were all silent failures -
 * `Array.isArray({conversations})` is false, `Number({unread:5})` is NaN - so
 * nothing would have thrown, the rail would just be empty.
 */

let failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { console.log(`  FAIL ${name} ${detail}`); failed++; }
};

console.log('toMessageDto');
const msg = chat.toMessageDto({
  id: 7, conversation_id: 1, sender_uid: 'email:a@x', sender_role: 'accounts',
  sender_name: 'Priya', body: 'hello',
  attachment_url: 'https://s3/x.png', attachment_name: 'x.png',
  attachment_type: 'image/png', attachment_size: '2048',
  client_id: 'c-1', created_at: '2026-01-01T00:00:00Z',
});
check('nested attachment object', msg.attachment && typeof msg.attachment === 'object');
check('attachment.url', msg.attachment.url === 'https://s3/x.png', msg.attachment?.url);
check('attachment.name', msg.attachment.name === 'x.png');
check('attachment.mime (not .type)', msg.attachment.mime === 'image/png');
check('attachment.size is a number', msg.attachment.size === 2048, typeof msg.attachment.size);
check('client_id present', msg.client_id === 'c-1');
check('no flat attachment_url leaks', msg.attachment_url === undefined);

const noAtt = chat.toMessageDto({ id: 8, conversation_id: 1, body: 'hi' });
check('attachment null when absent', noAtt.attachment === null);

const del = chat.toMessageDto({ id: 9, body: 'x', deleted_at: '2026-01-01T00:00:00Z' });
check('deleted message body is null', del.body === null, JSON.stringify(del.body));

console.log('toConversationDto');
const convo = chat.toConversationDto({
  id: 1, kind: 'group', title: 'Community', unread: 4, member_count: 12,
  last_message_id: 42, last_message_sender: 'email:b@x',
  last_message_body: 'hi all', last_message_at: '2026-01-01T00:00:00Z',
});
check('unread_count (not .unread)', convo.unread_count === 4, JSON.stringify(convo.unread_count));
check('unread not leaked', convo.unread === undefined);
check('nested last_message', convo.last_message && convo.last_message.id === 42);
check('last_message.body', convo.last_message.body === 'hi all');
check('member_count', convo.member_count === 12);

const empty = chat.toConversationDto({ id: 2, kind: 'direct', title: 'Priya', unread: 0 });
check('empty last_message is null', empty.last_message === null);
check('empty unread_count is 0', empty.unread_count === 0);

console.log('direct slug');
check('dm slug is order-independent', chat.directSlug('b', 'a') === chat.directSlug('a', 'b'));

// The notification type is a literal in two deployables with no shared module
// boundary. If these drift, the drawer's click handler silently stops matching
// chat rows and every chat notification becomes inert.
console.log('chat notification type');
const { CHAT_NOTIFICATION_TYPE: backendType } = await import(
  '../src/services/chatNotificationTypes.js'
);
const clientFile = new URL(
  '../../client/src/components/chat/chatNotificationTypes.js',
  import.meta.url
);
const clientSrc = readFileSync(clientFile, 'utf8');
const clientMatch = clientSrc.match(/CHAT_NOTIFICATION_TYPE\s*=\s*'([^']+)'/);
check('client file exists', !!clientMatch);
check(
  'client and backend agree on the type string',
  clientMatch?.[1] === backendType,
  `client=${clientMatch?.[1]} backend=${backendType}`
);

// notification_log.worker_id is a uuid with a foreign key into workers(id), so a
// subject_id that is not a worker uuid must never reach the insert. The Super
// Admin's subject_id is the literal '0'.
console.log('\nnotification recipient id');
const { notifyWorkerId } = await import('../src/services/chatNotificationTypes.js');
check('a real worker uuid passes through unchanged',
  notifyWorkerId('ab12cd34-ef56-7890-abcd-ef1234567890') === 'ab12cd34-ef56-7890-abcd-ef1234567890');
check("the Super Admin's '0' is dropped, not written", notifyWorkerId('0') === null);
check('a numeric worker id is dropped', notifyWorkerId('42') === null);
check('an empty id is dropped', notifyWorkerId('') === null);
check('undefined is dropped', notifyWorkerId(undefined) === null);
check('no client-side sentinel uuid is left behind',
  !clientSrc.includes('SUPER_ADMIN_NOTIFY_ID'));

// The uid the browser computes must equal the uid the server computes. These
// are two hand-written implementations of the same rule in two deployables,
// and they had already drifted once: the client looked only at id-ish fields,
// so the Super Admin - whose session user is {name, email, role} with no id -
// got no uid at all and the UI showed "your session has expired" for a valid
// session. Running both over the same session shapes is the only guard that
// catches it, because no HTTP test can: the failure happens before any request.
console.log('\nchat identity: client uid vs server uid');
const { chatUidFor } = await import('../src/models/chatModel.js');
const { resolveChatIdentity: clientIdentity } = await import(
  '../../client/src/components/chat/chatIdentity.js'
);

// Shapes taken from the real login responses, not invented.
const sessions = [
  ['super admin (no id, env email)', { name: 'Super Admin', email: 'Admin@UFS.com', role: 'super_admin' }],
  ['super admin, lowercase email', { name: 'Super Admin', email: 'admin@ufs.com', role: 'super_admin' }],
  ['accounts worker (id, no email)', { id: '61cb3a5f-49c2-4ec5-b565-f7aa7a712e1a', name: 'Vaishali', role: 'accounts' }],
  ['accounts worker, id 0', { id: 0, name: 'Odd', role: 'accounts' }],
  ['accounts worker (id and email)', { id: 'abc-123', email: 'v@ufs.com', name: 'Both', role: 'accounts' }],
  ['fro read-only (id only)', { id: 42, name: 'Sakshi', role: 'fro' }],
  ['hr with padded email', { name: 'Deepak', email: '  hr@ufs.com  ', role: 'hr' }],
  ['no user at all', null],
  ['empty object', {}],
];
for (const [label, sess] of sessions) {
  const server = chatUidFor(sess) ?? '';
  const client = clientIdentity(sess)?.uid ?? '';
  check(`agree: ${label}`, server === client, `server=${JSON.stringify(server)} client=${JSON.stringify(client)}`);
}

// The specific shape that produced the reported bug.
const sa = clientIdentity({ name: 'Super Admin', email: 'admin@ufs.com', role: 'super_admin' });
check('super admin gets a usable uid client-side', !!sa?.uid, String(sa?.uid));
check('and it is the email form the server stores', sa?.uid === 'email:admin@ufs.com', String(sa?.uid));
check('super admin is a writer', sa?.isWriter === true);
check('super admin can moderate Community', sa?.canModerate === true);

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
