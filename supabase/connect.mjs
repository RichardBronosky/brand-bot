// Local provisioning helper. Password stays out of command arguments and logs.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const password = readFileSync(new URL('../db-pw.txt', import.meta.url), 'utf8').trim();
const { connection } = JSON.parse(readFileSync(new URL('../supabase.local.json', import.meta.url), 'utf8'));
const parsed = new URL(connection);
if (parsed.password) throw new Error('Keep the password in db-pw.txt, not the connection string');
const env = { ...process.env, PGPASSWORD: password, PGCONNECT_TIMEOUT: '10' };
const action = process.argv[2] || 'check';
let sql = 'select current_database(), exists(select 1 from pg_namespace where nspname=\'brand\') as schema_present;';
if (action === 'install') sql = readFileSync(new URL('schema.sql', import.meta.url), 'utf8');
else if (action === 'invitee-messages') sql = readFileSync(new URL('migrations/002_invitee_messages.sql', import.meta.url), 'utf8');
else if (action === 'conversation-label') sql = readFileSync(new URL('migrations/003_conversation_label.sql', import.meta.url), 'utf8');
else if (action === 'location-history') sql = readFileSync(new URL('migrations/004_location_history.sql', import.meta.url), 'utf8');
else if (action === 'message-projection') sql = readFileSync(new URL('migrations/005_public_message_projection.sql', import.meta.url), 'utf8');
else if (action === 'audit') sql = readFileSync(new URL('audit.sql', import.meta.url), 'utf8');
else if (action === 'users') sql = 'select id from auth.users;';
else if (action === 'owner') {
  const id = process.argv[3];
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id || '')) throw new Error('Owner UUID required');
  sql = `insert into brand.owners(user_id) values ('${id}') on conflict do nothing;`;
} else if (action !== 'check') throw new Error('Use check, install, invitee-messages, users, or owner UUID');
const result = spawnSync('psql', ['-X', connection, '-v', 'ON_ERROR_STOP=1', '-f', '-'], { input: sql, env, encoding: 'utf8' });
if (result.error) throw result.error;
process.stdout.write(result.stdout || '');
process.stderr.write((result.stderr || '').split(password).join('[REDACTED]'));
process.exitCode = result.status ?? 1;
