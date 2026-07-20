-- =====================================================================
-- Marketing materials — private Supabase Storage bucket
-- - All authenticated users can list + read (via signed URLs)
-- - Only admin can upload, update, delete
-- Fully idempotent.
-- =====================================================================

insert into storage.buckets (id, name, public)
  values ('materials', 'materials', false)
  on conflict (id) do nothing;

-- Reps + admin can list + read
drop policy if exists "materials_read" on storage.objects;
create policy "materials_read"
  on storage.objects for select to authenticated
  using (bucket_id = 'materials');

-- Only admin can upload
drop policy if exists "materials_insert_admin" on storage.objects;
create policy "materials_insert_admin"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'materials' and public.is_admin());

-- Only admin can rename / replace
drop policy if exists "materials_update_admin" on storage.objects;
create policy "materials_update_admin"
  on storage.objects for update to authenticated
  using (bucket_id = 'materials' and public.is_admin())
  with check (bucket_id = 'materials' and public.is_admin());

-- Only admin can delete
drop policy if exists "materials_delete_admin" on storage.objects;
create policy "materials_delete_admin"
  on storage.objects for delete to authenticated
  using (bucket_id = 'materials' and public.is_admin());
