-- Run this in Supabase's SQL Editor (Dashboard -> SQL Editor), then use the
-- "Download as CSV" button on the results. Save the file as
-- scripts/data/auth_users.csv, then re-run: tsx scripts/import-csv-data.ts
--
-- This only reads auth.users — it does not modify anything.

select
  id,
  email,
  phone,
  encrypted_password,
  email_confirmed_at,
  created_at,
  updated_at
from auth.users
order by created_at;
