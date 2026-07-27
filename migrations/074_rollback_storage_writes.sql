-- ============================================================================
-- ROLLBACK for 074_lock_storage_writes.sql
-- Recreates the storage write policies exactly as they were before 074.
-- Only needed if image upload breaks somewhere that turns out NOT to use the
-- service_role client.
-- ============================================================================

CREATE POLICY "Allow public uploads" ON storage.objects
  FOR INSERT TO anon WITH CHECK (bucket_id = 'tiktok-images');

CREATE POLICY "Allow uploads to recipe-images" ON storage.objects
  FOR INSERT TO public WITH CHECK (bucket_id = 'recipe-images');
CREATE POLICY "Allow updates to recipe-images" ON storage.objects
  FOR UPDATE TO public USING (bucket_id = 'recipe-images');
CREATE POLICY "Allow deletes from recipe-images" ON storage.objects
  FOR DELETE TO public USING (bucket_id = 'recipe-images');

CREATE POLICY "Anyone can upload meal photos" ON storage.objects
  FOR INSERT TO anon, authenticated WITH CHECK (bucket_id = 'meal-photos');
CREATE POLICY "Users can upload own meal photos" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'meal-photos' AND (storage.foldername(name))[1] = (auth.uid())::text);
CREATE POLICY "Users can update own meal photos" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'meal-photos' AND (storage.foldername(name))[1] = (auth.uid())::text);
CREATE POLICY "Users can delete own meal photos" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'meal-photos' AND (storage.foldername(name))[1] = (auth.uid())::text);

CREATE POLICY "Authenticated users can upload ingredient images" ON storage.objects
  FOR INSERT TO public
  WITH CHECK (bucket_id = 'ingredient-images' AND auth.role() = 'authenticated');
CREATE POLICY "Users can update own ingredient images" ON storage.objects
  FOR UPDATE TO public
  USING (bucket_id = 'ingredient-images' AND (auth.uid() = owner OR (auth.jwt() ->> 'role') = 'admin'));
CREATE POLICY "Users can delete own ingredient images" ON storage.objects
  FOR DELETE TO public
  USING (bucket_id = 'ingredient-images' AND (auth.uid() = owner OR (auth.jwt() ->> 'role') = 'admin'));
