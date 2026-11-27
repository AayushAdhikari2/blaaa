# Supabase adapters — PRODUCTION-PREPARED, NOT ACTIVE IN V1

These adapters implement the same `RecipientProvider` / `NotificationSink` interfaces as the mock
adapters, for a **trusted server-side** deployment against real Carepulse V4 Supabase.

- `SupabaseRecipientProvider` — `profiles` table, roles `reception`/`admin`, `profiles.id`, re-checked.
- `SupabaseNotificationSink` — automation-owned `automation_notifications` (proposal `db/proposals/0003`),
  idempotent `ON CONFLICT`.

**V1 makes NO live Supabase calls. Nothing here is constructed by the local engine or dashboard.**
A server-side Supabase client (service-role key from server secrets, **never browser**) must be
injected explicitly. No service-role key is read from the environment in V1; none is logged.
See `docs/supabase-architecture.md` + `db/proposals/`. **No migration is applied.**
