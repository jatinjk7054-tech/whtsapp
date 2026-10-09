// Supabase-compatible query builder + S3 storage shim for the Sevak Library
// module. Everything that used to run against Supabase (queries, storage,
// rpc) now runs against the main UCS CRM database via config/db.js, so
// services here can talk to `db` exactly like they would to a supabase-js
// client.
import db from '../../config/db.js'

export default db