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
});

// Upload hashed device contacts. Hashes you've already uploaded are skipped.
contactsRouter.put(
  "/",
  asyncHandler(async (req, res) => {
    const { contacts } = syncSchema.parse(req.body);
    const unique = new Map(contacts.map((c) => [c.phone_hash.toLowerCase(), c.name ?? null]));
    const result = await prisma.deviceContacts.createMany({
      data: [...unique].map(([phone_hash, contact_name]) => ({ owner_id: req.userId!, phone_hash, contact_name })),
      skipDuplicates: true,
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
 * excluding you and anyone blocked either way. The hash is SHA-256 of the profile's digits-only
 * phone number, computed here with Postgres' built-in sha256 (no pgcrypto extension needed).
 */
contactsRouter.get(
  "/matches",
  asyncHandler(async (req, res) => {
    const me = req.userId!;
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const rows = await prisma.$queryRaw<unknown[]>(Prisma.sql`
      SELECT p.user_id, p.display_name, p.username, p.avatar_url, dc.contact_name,
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
      FROM device_contacts dc
      JOIN profiles p
        ON p.phone_number IS NOT NULL
       AND encode(sha256(convert_to(regexp_replace(p.phone_number, '[^0-9]', '', 'g'), 'UTF8')), 'hex') = dc.phone_hash
      WHERE dc.owner_id = ${me}::uuid
        AND p.user_id <> ${me}::uuid
        AND NOT EXISTS (
          SELECT 1 FROM user_blocks ub
          WHERE (ub.blocker_id = ${me}::uuid AND ub.blocked_id = p.user_id)
             OR (ub.blocker_id = p.user_id AND ub.blocked_id = ${me}::uuid)
        )
      ORDER BY p.display_name NULLS LAST
      LIMIT ${limit}`);
    res.json(rows);
  })
);
