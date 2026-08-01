/**
 * One-time data import: loads Supabase "Export as CSV" files (from the
 * dashboard's Table Editor) into the new backend's Postgres database.
 *
 * IMPORTANT — read before running:
 * This imports all `public` schema app data (profiles, posts, messages,
 * rooms, wallet history, everything). It does NOT import login credentials,
 * because Supabase's dashboard CSV export only covers the `public` schema —
 * emails and password hashes live in `auth.users`, which isn't included.
 *
 * To keep every foreign-key reference intact, this script creates a
 * *placeholder* row in `users` for every user_id found in profiles.csv,
 * with a random, unusable, unrecoverable password hash and no email. These
 * accounts cannot log in. Once you export `auth.users` (see
 * scripts/export-auth-users.sql for the exact query to run in Supabase's
 * SQL Editor) and place the result at scripts/data/auth_users.csv, re-run
 * this script — it will detect the file and patch in real emails +
 * password hashes for the matching placeholder rows.
 *
 * Usage:
 *   DATABASE_URL="postgresql://..." tsx scripts/import-csv-data.ts
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { parse } from "csv-parse/sync";
import { Client } from "pg";
import bcrypt from "bcryptjs";

const DATA_DIR = path.join(__dirname, "data");
const METADATA_PATH = path.join(__dirname, "table-metadata", "tables.json");

type ColumnKind =
  | "uuid"
  | "text"
  | "text_array"
  | "boolean"
  | "int"
  | "bigint"
  | "decimal"
  | "timestamptz"
  | "date"
  | "json";

interface ColumnMeta {
  name: string;
  kind: ColumnKind;
  nullable: boolean;
}
interface TableMeta {
  pk: string[];
  columns: ColumnMeta[];
}

const tableMetadata: Record<string, TableMeta> = JSON.parse(fs.readFileSync(METADATA_PATH, "utf8"));

// Tables imported generically from CSV, in an order that's convenient for
// log readability. Actual FK ordering only matters for `profiles`, which is
// handled separately (after placeholder users are created) — every other
// table's user/room/post-id-like columns are plain scalars with no
// database-level FK in the new schema, so order doesn't affect correctness.
const IMPORT_ORDER = Object.keys(tableMetadata).filter((t) => t !== "profiles");

function coerce(raw: string, kind: ColumnKind): unknown {
  if (raw === "" || raw === undefined) return null;
  switch (kind) {
    case "boolean":
      return raw === "true" || raw === "t";
    case "int":
    case "bigint":
      return Number.parseInt(raw, 10);
    case "decimal":
      return raw; // pass through as string; pg + numeric columns handle this fine
    case "text_array":
      try {
        return JSON.parse(raw);
      } catch {
        console.warn(`  ! Could not parse array value, storing as null: ${raw.slice(0, 60)}`);
        return null;
      }
    case "json":
      return raw; // valid JSON text already; bound with an explicit ::jsonb cast below
    default:
      return raw;
  }
}

function readCsv(table: string): Record<string, string>[] | null {
  const file = path.join(DATA_DIR, `${table}.csv`);
  if (!fs.existsSync(file)) return null;
  const content = fs.readFileSync(file, "utf8");
  if (!content.trim()) return [];
  return parse(content, { delimiter: ";", columns: true, relax_quotes: true, skip_empty_lines: true });
}

const BATCH_SIZE = 500;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function importTable(client: Client, table: string) {
  const meta = tableMetadata[table];
  const rows = readCsv(table);
  if (rows === null) {
    console.log(`  (no CSV found for ${table}, skipping)`);
    return 0;
  }
  if (rows.length === 0) return 0;

  const columns = meta.columns.map((c) => c.name);
  const quotedCols = columns.map((c) => `"${c}"`).join(", ");
  const conflictCols = meta.pk.join(", ");
  const batches = chunk(rows, BATCH_SIZE);
  let inserted = 0;

  for (const [batchIndex, batch] of batches.entries()) {
    const values: unknown[] = [];
    const tuples: string[] = [];

    for (const row of batch) {
      const rowValues = meta.columns.map((c) => coerce(row[c.name], c.kind));
      const startIdx = values.length;
      const placeholders = meta.columns.map((c, i) => {
        const paramNum = startIdx + i + 1;
        return c.kind === "json" ? `$${paramNum}::jsonb` : `$${paramNum}`;
      });
      tuples.push(`(${placeholders.join(", ")})`);
      values.push(...rowValues);
    }

    await client.query(
      `INSERT INTO public.${table} (${quotedCols}) VALUES ${tuples.join(", ")}
       ON CONFLICT (${conflictCols}) DO NOTHING`,
      values
    );
    inserted += batch.length;
    if (batches.length > 1) {
      process.stdout.write(`\r  Importing ${table}... ${inserted}/${rows.length} `);
    }
  }
  if (batches.length > 1) process.stdout.write("\n");
  return inserted;
}

/** Every profile needs a `users` row to satisfy the profiles_user_id_fkey constraint. */
async function createPlaceholderUsers(client: Client) {
  const profileRows = readCsv("profiles");
  if (!profileRows || profileRows.length === 0) return 0;

  const unusableHash = await bcrypt.hash(
    // A random value that's discarded immediately after hashing — this hash
    // can never be produced by any real password, so these accounts are
    // cryptographically locked out until real credentials are patched in.
    require("crypto").randomBytes(32).toString("hex"),
    12
  );

  const userIds = [...new Set(profileRows.map((r) => r.user_id).filter(Boolean))];
  let created = 0;

  for (const batch of chunk(userIds, BATCH_SIZE)) {
    const values: unknown[] = [];
    const tuples: string[] = [];
    for (const userId of batch) {
      tuples.push(`($${values.length + 1}, $${values.length + 2})`);
      values.push(userId, unusableHash);
    }
    const result = await client.query(
      `INSERT INTO public.users (id, password_hash) VALUES ${tuples.join(", ")}
       ON CONFLICT (id) DO NOTHING`,
      values
    );
    created += result.rowCount ?? 0;
  }
  return created;
}

/** If scripts/data/auth_users.csv exists (see scripts/export-auth-users.sql), patch in real credentials. */
async function patchRealCredentials(client: Client) {
  const file = path.join(DATA_DIR, "auth_users.csv");
  if (!fs.existsSync(file)) {
    console.log("\n(No auth_users.csv found — accounts created as placeholders, see script header for next steps.)");
    return;
  }
  const content = fs.readFileSync(file, "utf8");
  const rows: Record<string, string>[] = parse(content, {
    delimiter: content.includes(";") ? ";" : ",",
    columns: true,
    relax_quotes: true,
    skip_empty_lines: true,
  });

  let patched = 0;
  for (const row of rows) {
    if (!row.id || !row.encrypted_password) continue;
    await client.query(
      `UPDATE public.users
       SET email = $2, phone = NULLIF($3, ''), password_hash = $4,
           email_verified_at = NULLIF($5, '')::timestamptz
       WHERE id = $1`,
      [row.id, row.email || null, row.phone || "", row.encrypted_password, row.email_confirmed_at || ""]
    );
    patched++;
  }
  console.log(`Patched real credentials for ${patched} users from auth_users.csv`);
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("Set DATABASE_URL to your target (new) Postgres connection string");

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  console.log("Connected to target database.\n");

  try {
    console.log("Creating placeholder user accounts for every profile...");
    const created = await createPlaceholderUsers(client);
    console.log(`  -> ${created} placeholder users created (pre-existing ones left untouched)\n`);

    console.log("Importing profiles...");
    const profileCount = await importTable(client, "profiles");
    console.log(`  -> ${profileCount} rows\n`);

    for (const table of IMPORT_ORDER) {
      process.stdout.write(`Importing ${table}... `);
      const count = await importTable(client, table);
      console.log(`${count} rows`);
    }

    await patchRealCredentials(client);

    console.log("\nDone.");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
