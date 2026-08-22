# National API cursor-secret operations

Migration `0037_national_api.sql` is a fresh migration applied after
`0036_national_property_record.sql`. Production has not received `0037`; do
not retrofit destructive upgrade steps into it. Re-run the contract test by
recreating a disposable database from a known baseline, then applying the
migration and test in that database.

The matching rollback refuses to run while a DMV publication is active. Roll
the Worker back first, clear the publication pointer, verify a current backup,
and then explicitly acknowledge the destructive API rollback in the same
database session:

```sql
set quoin.confirm_dmv_api_rollback = 'DROP_PUBLISHED_DMV_API';
\i db/rollbacks/0037_national_api.sql
```

Do not set that acknowledgement in a shared connection-pool configuration.
It is a one-session operator safeguard, not an application setting.

The migration creates one database-local 32-byte key in
`meta.api_cursor_secret`. The key is generated only when the row is absent,
is readable only by `api_owner`, and is consumed by the security-definer
`meta.national_cursor_hmac` helper. Never print, log, or include the key in
application configuration or a cursor.

Backups containing this table must be encrypted and access-controlled. A
restore that preserves the key preserves cursor verification; a restore or
controlled rotation with a new key invalidates every existing cursor. After a
rotation, API clients must discard cursors and restart searches from page one.

The current deliberate ceiling is no issued-at, key-id, or TTL field in the
cursor. Cursors remain valid while their keyed MAC and publication/generation
binding remain valid. If explicit expiry is required later, add a coordinated
key-id/issued-at/TTL API revision and test it before enabling rotation; do not
silently change the current cursor format.
