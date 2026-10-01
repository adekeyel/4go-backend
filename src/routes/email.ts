import { Router } from "express";
import { prisma } from "@/lib/prisma";
import { asyncHandler } from "@/middleware/errorHandler";
import { unsubscribePage } from "@/lib/emailTemplates";

// Public (no login): opened from the "Unsubscribe" link in an email or by a mail app's one-click button.
export const emailRouter = Router();

const tokenOf = (q: unknown) => (typeof q === "string" && /^[0-9a-f]{16,128}$/i.test(q) ? q : null);

// GET only shows a confirmation button. Mail scanners often open every link in a message, so a bare GET
// must never unsubscribe anyone.
emailRouter.get(
  "/unsubscribe",
  asyncHandler(async (req, res) => {
    const token = tokenOf(req.query.token);
    const row = token ? await prisma.emailUnsubscribeTokens.findUnique({ where: { token } }) : null;
    res.type("html");
    if (!row) return res.status(404).send(unsubscribePage("invalid"));
    if (row.used_at) return res.send(unsubscribePage("done", { email: row.email }));
    res.send(unsubscribePage("confirm", { email: row.email, action: `/api/email/unsubscribe?token=${token}` }));
  })
);

// The confirmation button and the RFC 8058 one-click header (List-Unsubscribe-Post) both POST here.
emailRouter.post(
  "/unsubscribe",
  asyncHandler(async (req, res) => {
    const token = tokenOf(req.query.token);
    const row = token ? await prisma.emailUnsubscribeTokens.findUnique({ where: { token } }) : null;
    res.type("html");
    if (!row) return res.status(404).send(unsubscribePage("invalid"));

    await prisma.$transaction([
      prisma.suppressedEmails.upsert({
        where: { email: row.email },
        create: { email: row.email, reason: "unsubscribe" },
        update: {},
      }),
      prisma.emailUnsubscribeTokens.update({ where: { id: row.id }, data: { used_at: row.used_at ?? new Date() } }),
    ]);
    res.send(unsubscribePage("done", { email: row.email }));
  })
);
