-- Carepulse HMS v5 (private reports) — run AFTER v3/v4. Safe to re-run.
-- Makes the reports bucket private, limits size (10 MB) and type (PDF/JPG/PNG/WebP),
-- and lets staff create short-lived signed links. Patients get links from the report-link function.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('reports','reports',false,10485760,array['application/pdf','image/jpeg','image/png','image/webp'])
on conflict (id) do update set public=false, file_size_limit=10485760,
  allowed_mime_types=array['application/pdf','image/jpeg','image/png','image/webp'];

drop policy if exists "staff read reports" on storage.objects;
create policy "staff read reports" on storage.objects for select to authenticated
  using (bucket_id='reports' and my_role() in ('doctor','lab','admin'));
