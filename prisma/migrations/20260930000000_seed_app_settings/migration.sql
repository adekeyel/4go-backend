-- Default platform settings (the Lovable project seeded these; they were missing from the Prisma init). Safe to re-run.
INSERT INTO app_settings (key, value, label, category) VALUES
  ('signups_enabled', 'true'::jsonb, 'Allow New Signups', 'app'),
  ('maintenance_mode', 'false'::jsonb, 'Maintenance Mode', 'app'),
  ('min_age', '18'::jsonb, 'Minimum Age', 'app'),
  ('max_room_members', '500'::jsonb, 'Max Room Members', 'chat'),
  ('allow_media_uploads', 'true'::jsonb, 'Allow Media Uploads', 'chat'),
  ('allow_voice_notes', 'true'::jsonb, 'Allow Voice Notes', 'chat'),
  ('profanity_filter', 'true'::jsonb, 'Profanity Filter', 'moderation'),
  ('auto_suspend_reports', '5'::jsonb, 'Auto-flag After N Reports', 'moderation'),
  ('require_verification_payout', 'true'::jsonb, 'Require Verification For Payout', 'moderation'),
  ('max_upload_mb', '25'::jsonb, 'Max Upload Size (MB)', 'storage')
ON CONFLICT (key) DO NOTHING;
