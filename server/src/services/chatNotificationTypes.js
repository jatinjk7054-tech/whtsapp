/**
 * The `type` written into notification_log for a chat message.
 *
 * Kept in its own module so the service, the client drawer icon mapping and any
 * future filter all read the same string instead of three copies of a literal.
 *
 * notification_log.type is app-controlled routing text and its stale CHECK
 * constraint is dropped on every boot by
 * bootstrap/ensureNotificationLogTypes.js, so a new value needs no migration.
 */
export const CHAT_NOTIFICATION_TYPE = 'chat_message';

/**
 * Validate a chat subject_id before it is written to notification_log.
 *
 * notification_log.worker_id is `uuid` and carries a foreign key into
 * workers(id) ON DELETE CASCADE, so a row can only ever belong to a real worker.
 * The env-configured Super Admin has no workers row and their subject_id is the
 * literal '0', which is neither a uuid nor a workers row. Inserting it fails
 * with `invalid input syntax for type uuid: "0"`, and because the whole fan-out
 * is a single multi-row insert, one such row took the other 69 down with it.
 *
 * Returning null instead of substituting a placeholder matters for that reason:
 * a fake uuid would be type-valid but still violate the foreign key, and the
 * Super Admin is deliberately not notified, so there is nothing to lose by
 * dropping them. The null return also keeps a future non-worker participant from
 * breaking every other recipient's notification.
 *
 * @param {string|number} subjectId chat subject_id
 * @returns {string|null} the uuid to write, or null to skip this participant
 */
export function notifyWorkerId(subjectId) {
  const s = String(subjectId ?? '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) {
    return null;
  }
  return s;
}
