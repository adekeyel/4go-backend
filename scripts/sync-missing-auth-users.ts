/**
 * Backfills Supabase accounts that exist in auth.users (scripts/data/auth_users.csv)
 * but have no row in the new backend's `users` / `profiles` tables.
 *
 * Why this is needed: import-csv-data.ts only creates `users` rows for user_ids
 * found in profiles.csv, and its auth_users.csv step only UPDATEs existing rows.
 * Anyone who signed up in Supabase but never got a profile row (e.g. never
 * finished "set up your profile") was therefore never created here.
 *
 * What it does (all inside one transaction):
 *   1. INSERTs a `users` row for every auth_users.csv id not already in `users`,
 *      keeping the SAME id, real email, real bcrypt hash and verified timestamp,
 *      so those people can log in with their existing password.
 *   2. INSERTs a `profiles` row for every user without one, mirroring what
 *      POST /api/auth/signup creates: username = NULL (the app sends them to
 *      the profile-setup page), display_name = email prefix, fresh referral code.
 *
 * Safe to re-run: existing rows are never modified (ON CONFLICT DO NOTHING).
 *
 * Usage (from the backend root):
 *   DRY_RUN=1 DATABASE_URL="postgresql://..." npx tsx scripts/sync-missing-auth-users.ts   # preview only
 *             DATABASE_URL="postgresql://..." npx tsx scripts/sync-missing-auth-users.ts   # apply
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { parse } from "csv-parse/sync";
import { Client } from "pg";

const AUTH_CSV = path.join(__dirname, "data", "auth_users.csv");
const DRY_RUN = process.env.DRY_RUN === "1";

const generateReferralCode = () => crypto.randomBytes(4).toString("hex").toUpperCase();

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("Set DATABASE_URL to your target (new) Postgres connection string");

  const content = fs.readFileSync(AUTH_CSV, "utf8");
  const rows: Record<string, string>[] = parse(content, {
    delimiter: content.split("\n", 1)[0].includes(";") ? ";" : ",",
    columns: true,
    relax_quotes: true,
    skip_empty_lines: true,
    bom: true,
  });

  const required = ["id", "email", "encrypted_password"];
  const missingCols = required.filter((c) => !(rows[0] && c in rows[0]));
  if (missingCols.length) throw new Error(`auth_users.csv is missing column(s): ${missingCols.join(", ")}`);

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const beforeUsers = Number((await client.query("SELECT count(*) FROM public.users")).rows[0].count);
    const beforeProfiles = Number((await client.query("SELECT count(*) FROM public.profiles")).rows[0].count);
    console.log(`Before: ${beforeUsers} users, ${beforeProfiles} profiles. auth_users.csv has ${rows.length} accounts.\n`);

    await client.query("BEGIN");

    // 1) users
    let usersInserted = 0;
    let skipped = 0;
    for (const r of rows) {
      if (!r.id || !r.email || !r.encrypted_password) {
        skipped++;
        continue;
      }
      const res = await client.query(
        `INSERT INTO public.users (id, email, phone, password_hash, email_verified_at, created_at, updated_at)
         VALUES ($1, $2, NULLIF($3, ''), $4, NULLIF($5, '')::timestamptz,
                 COALESCE(NULLIF($6, '')::timestamptz, now()),
                 COALESCE(NULLIF($7, '')::timestamptz, now()))
         ON CONFLICT DO NOTHING`,
        [
          r.id,
          r.email.toLowerCase().trim(),
          r.phone ?? "",
          r.encrypted_password,
          r.email_confirmed_at ?? "",
          r.created_at ?? "",
          r.updated_at ?? "",
        ]
      );
      if (res.rowCount) {
        usersInserted++;
        console.log(`  + user    ${r.id}  ${r.email}`);
      }
    }

    // 2) profiles for any user that has none (generate codes in JS, same as the signup route)
    const needProfile = await client.query(
      `SELECT u.id, u.email, u.created_at
         FROM public.users u
         LEFT JOIN public.profiles p ON p.user_id = u.id
        WHERE p.user_id IS NULL`
    );
    let profilesInserted = 0;
    for (const u of needProfile.rows) {
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await client.query("SAVEPOINT p");
          await client.query(
            `INSERT INTO public.profiles (user_id, username, display_name, referral_code, created_at, updated_at)
             VALUES ($1, NULL, $2, $3, $4, $4)`,
            [u.id, (u.email ?? "user").split("@")[0], generateReferralCode(), u.created_at]
          );
          await client.query("RELEASE SAVEPOINT p");
          profilesInserted++;
          console.log(`  + profile ${u.id}  ${u.email}`);
          break;
        } catch (err: any) {
          await client.query("ROLLBACK TO SAVEPOINT p");
          if (err?.code !== "23505" || attempt === 4) throw err; // retry only on referral_code collision
        }
      }
    }

    const afterUsers = Number((await client.query("SELECT count(*) FROM public.users")).rows[0].count);
    const afterProfiles = Number((await client.query("SELECT count(*) FROM public.profiles")).rows[0].count);
    console.log(
      `\nInserted ${usersInserted} users and ${profilesInserted} profiles` +
        (skipped ? ` (${skipped} CSV rows skipped: missing id/email/hash)` : "") +
        `.\nAfter:  ${afterUsers} users, ${afterProfiles} profiles.`
    );

    if (DRY_RUN) {
      await client.query("ROLLBACK");
      console.log("\nDRY_RUN=1 -> rolled back, nothing was saved.");
    } else {
      await client.query("COMMIT");
      console.log("\nCommitted.");
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
