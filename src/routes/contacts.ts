import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/middleware/auth";
import { asyncHandler } from "@/middleware/errorHandler";

export const contactsRouter = Router();
contactsRouter.use(requireAuth);

const syncSchema = z.object({
  contacts: z
    .array(
      z.object({
        // SHA-256 of the contact's phone number, digits only, computed on the device (raw numbers never leave it).
        phone_hash: z.string().regex(/^[0-9a-fA-F]{64}$/),
        name: z.string().max(100).nullish(),
      })
    )
    .max(2000),
  // true = this upload is the whole address book: contacts you've since deleted on the phone are forgotten too.
  replace: z.boolean().optional(),
});

// Upload hashed device contacts. Hashes you've already uploaded are skipped.
contactsRouter.put(
  "/",
  asyncHandler(async (req, res) => {
    const { contacts, replace } = syncSchema.parse(req.body);
    const unique = new Map(contacts.map((c) => [c.phone_hash.toLowerCase(), c.name ?? null]));
    const result = await prisma.$transaction(async (tx) => {
      if (replace) await tx.deviceContacts.deleteMany({ where: { owner_id: req.userId!, phone_hash: { notIn: [...unique.keys()] } } });
      return tx.deviceContacts.createMany({
        data: [...unique].map(([phone_hash, contact_name]) => ({ owner_id: req.userId!, phone_hash, contact_name })),
        skipDuplicates: true,
      });
    });
    res.json({ received: unique.size, added: result.count });
  })
);

// Forget all of your uploaded contacts.
contactsRouter.delete(
  "/",
  asyncHandler(async (req, res) => {
    await prisma.deviceContacts.deleteMany({ where: { owner_id: req.userId! } });
    res.status(204).send();
  })
);

/**
 * Ports find_contact_matches: people on 4GO whose phone number hashes to one of your contacts,
 * excluding you and anyone blocked either way.
 *
 * Numbers are written many ways: profiles hold "0802 123 4567", "8021234567" or "+234 802 123 4567", and the
 * phone's address book holds yet other forms. The device hashes the digits of the number as saved, so each
 * profile is matched under four spellings of the same number: as stored, the last 10 digits, 0 + last 10, and
 * 234 + last 10. (Matching only the stored form missed most real contacts.)
 * ?limit (max 200) and ?offset page through the people; each person appears once however many contacts they match.
 */
contactsRouter.get(
  "/matches",
  asyncHandler(async (req, res) => {
    const me = req.userId!;
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const rows = await prisma.$queryRaw<unknown[]>(Prisma.sql`
      WITH mine AS (SELECT phone_hash, contact_name FROM device_contacts WHERE owner_id = ${me}::uuid),
      digits AS (
        SELECT p.user_id, regexp_replace(p.phone_number, '[^0-9]', '', 'g') AS d
          FROM profiles p
         WHERE p.phone_number IS NOT NULL AND p.user_id <> ${me}::uuid AND EXISTS (SELECT 1 FROM mine)
      ),
      cand AS (
        SELECT user_id, x AS num FROM digits, LATERAL unnest(
          CASE WHEN length(d) >= 10
               THEN ARRAY[d, right(d, 10), '0' || right(d, 10), '234' || right(d, 10)]
               ELSE ARRAY[d] END) AS x
         WHERE d <> ''
      ),
      hit AS (
        SELECT DISTINCT ON (c.user_id) c.user_id, m.contact_name
          FROM cand c
          JOIN mine m ON m.phone_hash = encode(sha256(convert_to(c.num, 'UTF8')), 'hex')
         ORDER BY c.user_id, (m.contact_name IS NULL), m.contact_name
      )
      SELECT p.user_id, p.display_name, p.username, p.avatar_url, h.contact_name,
        EXISTS (
          SELECT 1 FROM friends f
          WHERE f.status = 'accepted'
            AND ((f.requester_id = ${me}::uuid AND f.addressee_id = p.user_id)
              OR (f.requester_id = p.user_id AND f.addressee_id = ${me}::uuid))
        ) AS is_friend,
        EXISTS (
          SELECT 1 FROM friends f
          WHERE f.status = 'pending'
            AND ((f.requester_id = ${me}::uuid AND f.addressee_id = p.user_id)
              OR (f.requester_id = p.user_id AND f.addressee_id = ${me}::uuid))
        ) AS has_pending_request
      FROM hit h
      JOIN profiles p ON p.user_id = h.user_id
      WHERE NOT EXISTS (
          SELECT 1 FROM user_blocks ub
          WHERE (ub.blocker_id = ${me}::uuid AND ub.blocked_id = p.user_id)
             OR (ub.blocker_id = p.user_id AND ub.blocked_id = ${me}::uuid)
        )
      ORDER BY p.display_name NULLS LAST, p.user_id
      LIMIT ${limit} OFFSET ${offset}`);
    res.json(rows);
  })
);
