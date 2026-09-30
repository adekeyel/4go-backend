import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { requireAuth, optionalAuth } from "@/middleware/auth";
import { asyncHandler } from "@/middleware/errorHandler";
import { isAllowedPushEndpoint } from "@/lib/push";

export const pushRouter = Router();

const endpointSchema = z
  .string()
  .max(2048)
  .refine(isAllowedPushEndpoint, "Unsupported push service endpoint");
const keySchema = z.string().min(1).max(256);

// The public VAPID key the browser needs for pushManager.subscribe().
pushRouter.get("/vapid-public-key", (_req, res) => {
  res.json({ publicKey: env.vapid.publicKey });
});

// Register this browser/device for the signed-in user. Accepts { endpoint, keys: { p256dh, auth } }
// (what PushSubscription.toJSON() gives) or the flat { endpoint, p256dh, auth }.
const subscribeSchema = z
  .object({
    endpoint: endpointSchema,
    keys: z.object({ p256dh: keySchema, auth: keySchema }).optional(),
    p256dh: keySchema.optional(),
    auth: keySchema.optional(),
  })
  .refine((b) => b.keys || (b.p256dh && b.auth), "Missing keys");

pushRouter.post(
  "/subscribe",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = subscribeSchema.parse(req.body);
    const p256dh = body.keys?.p256dh ?? body.p256dh!;
    const auth = body.keys?.auth ?? body.auth!;
    // An endpoint identifies one browser install. If another account was signed in there before,
    // the device now belongs to whoever is signed in (endpoint is unique across all users).
    await prisma.pushSubscriptions.upsert({
      where: { endpoint: body.endpoint },
      create: { user_id: req.userId!, endpoint: body.endpoint, p256dh, auth },
      update: { user_id: req.userId!, p256dh, auth, updated_at: new Date() },
    });
    res.status(201).json({ ok: true });
  })
);

// Stop notifications to this device (e.g. on sign-out).
pushRouter.post(
  "/unsubscribe",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { endpoint } = z.object({ endpoint: z.string().max(2048) }).parse(req.body);
    await prisma.pushSubscriptions.deleteMany({ where: { endpoint, user_id: req.userId! } });
    res.status(204).send();
  })
);

/**
 * Ports rotate-push-subscription. A browser occasionally swaps a subscription for a new one; its service
 * worker reports that with no login available, so this endpoint accepts the request unauthenticated and
 * works out the owner from (in order) the auth token if present, the old endpoint's row, or the
 * new endpoint's existing row. Endpoints are long unguessable URLs, so knowing the old one is the credential.
 */
const rotateSchema = z.object({
  oldEndpoint: z.string().max(2048).optional(),
  endpoint: endpointSchema,
  p256dh: keySchema,
  auth: keySchema,
});

pushRouter.post(
  "/rotate",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const { oldEndpoint, endpoint, p256dh, auth } = rotateSchema.parse(req.body);

    const result = await prisma.$transaction(async (tx) => {
      let userId: string | null = req.userId ?? null;

      if (oldEndpoint) {
        const old = await tx.pushSubscriptions.findUnique({ where: { endpoint: oldEndpoint }, select: { user_id: true } });
        userId = userId ?? old?.user_id ?? null;
        if (userId && oldEndpoint !== endpoint) {
          await tx.pushSubscriptions.deleteMany({ where: { endpoint: oldEndpoint } });
        }
      }
      if (!userId) {
        const current = await tx.pushSubscriptions.findUnique({ where: { endpoint }, select: { user_id: true } });
        userId = current?.user_id ?? null;
      }
      if (!userId) return { ok: false, reason: "no_mapping" as const };

      await tx.pushSubscriptions.upsert({
        where: { endpoint },
        create: { user_id: userId, endpoint, p256dh, auth },
        update: { user_id: userId, p256dh, auth, updated_at: new Date() },
      });
      return { ok: true as const };
    });
    res.json(result);
  })
);
