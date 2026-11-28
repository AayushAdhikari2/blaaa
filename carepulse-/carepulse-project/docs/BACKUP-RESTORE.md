# Backup and restore drill

A backup you have never restored is only a hope. Do this drill before the pilot and every three months.

## What is backed up
- **Nightly** (`.github/workflows/backup.yml`): the `public` schema (all clinic data) as an encrypted file, kept 30 days as a workflow artifact in a **private** repo.
- **Supabase’s own backups** (paid plan: daily; point-in-time recovery is an extra): include the login accounts (`auth` schema). Turn them on.
- **Report files** (storage bucket `reports`) are *not* in the SQL dump. Download them now and then (Supabase > Storage) or use Supabase’s storage backup option.

## Restore drill
1. Create a **new, empty** Supabase project (never restore over the live one while testing).
2. SQL Editor: run `app/setup.sql` (creates structure, roles, policies).
3. Download the newest `carepulse-….sql.gz.gpg` from GitHub > Actions > the run > Artifacts.
4. On a computer with your **private** gpg key: `gpg --decrypt carepulse-DATE.sql.gz.gpg | gunzip > backup.sql`
5. Load the data only: edit nothing, then `psql "<new project connection string>" -f backup.sql` (errors about objects that already exist are expected; row inserts must succeed). If you prefer, dump with `--data-only` instead by changing the workflow.
6. Check: `app/check.html` against the new project; open Admin > Reports for last week; Admin > Audit log > **Verify chain** must say intact.
7. Write down the date, how long it took, and anything that surprised you. Delete the restored copy when finished (it holds patient data).

## If you ever really need to restore
Stop staff from using the system, restore into a **new** project, point `app/config.js` at it, re-create staff logins if the `auth` data was not restored, and tell your privacy contact. Keep the damaged project until the cause is known.
