import express from "express";
import http from "http";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { env } from "@/lib/env";
import { errorHandler } from "@/middleware/errorHandler";
import { initSockets } from "@/sockets";

import { authRouter } from "@/routes/auth";
import { profilesRouter } from "@/routes/profiles";
import { friendsRouter } from "@/routes/friends";
import { roomsRouter } from "@/routes/rooms";
import { messagesRouter } from "@/routes/messages";
import { feedRouter } from "@/routes/feed";
import { uploadsRouter } from "@/routes/uploads";
import { walletRouter } from "@/routes/wallet";
import { pagesRouter } from "@/routes/pages";
import { statusesRouter } from "@/routes/statuses";
import { contestsRouter } from "@/routes/contests";
import { referralsRouter } from "@/routes/referrals";
import { verificationRouter } from "@/routes/verification";
import { supportRouter } from "@/routes/support";
import { contactsRouter } from "@/routes/contacts";
import { pushRouter } from "@/routes/push";
import { emailRouter } from "@/routes/email";
import { broadcastRouter } from "@/routes/broadcast";
import { notificationsRouter } from "@/routes/notifications";
import { startEmailWorker } from "@/lib/emailQueue";
import { payoutsRouter } from "@/routes/payouts";
import { webhooksRouter } from "@/routes/webhooks";
import { startMaintenance } from "@/lib/maintenance";
import { adsRouter } from "@/routes/ads";
import { videoAdsRouter } from "@/routes/videoAds";
import { employeesRouter } from "@/routes/employees";
import { roomStatsRouter } from "@/routes/roomStats";
import { paymentsRouter } from "@/routes/payments";
import { adminRouter } from "@/routes/admin";
import { callsRouter } from "@/routes/calls";
import { moderationRouter } from "@/routes/moderation";
import { mentionsRouter } from "@/routes/mentions";
import { settingsRouter } from "@/routes/settings";

const app = express();

// Without this, req.ip is the proxy's address for every visitor (affects banner ad counting, login session
// addresses and the video-ad limits). See TRUST_PROXY in lib/env.ts.
if (env.trustProxy > 0) app.set("trust proxy", env.trustProxy);

app.use(helmet());
app.use(
  cors({
    origin: env.clientOrigins.length ? env.clientOrigins : true,
    credentials: true,
  })
);
app.use(cookieParser());
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

app.get("/health", (_req, res) => res.json({ ok: true }));

// Shows the address this server believes the caller has. Open it from your phone or laptop: if "ip" is your own
// public address, TRUST_PROXY is right. If it's some other (shared) address, raise TRUST_PROXY by one and
// check again. Only reveals the caller's own request details.
app.get("/health/ip", (req, res) =>
  res.json({ ip: req.ip, forwarded_for: req.headers["x-forwarded-for"] ?? null, trust_proxy_hops: env.trustProxy })
);

app.use("/api/auth", authRouter);
app.use("/api/profiles", profilesRouter);
app.use("/api/friends", friendsRouter);
app.use("/api/rooms/member-counts", roomStatsRouter); // before the rooms router so "member-counts" isn't read as a room id
app.use("/api/rooms", roomsRouter);
app.use("/api/messages", messagesRouter);
app.use("/api/feed", feedRouter);
app.use("/api/pages", pagesRouter);
app.use("/api/statuses", statusesRouter);
app.use("/api/contests", contestsRouter);
app.use("/api/referrals", referralsRouter);
app.use("/api/verification", verificationRouter);
app.use("/api/support", supportRouter);
app.use("/api/contacts", contactsRouter);
app.use("/api/push", pushRouter);
app.use("/api/email", emailRouter);
app.use("/api/broadcast", broadcastRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/payouts", payoutsRouter);
app.use("/api/webhooks", webhooksRouter);
app.use("/api/ads", adsRouter);
app.use("/api/video-ads", videoAdsRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/employees", employeesRouter);
app.use("/api/uploads", uploadsRouter);
app.use("/api/wallet", walletRouter);
app.use("/api/payments", paymentsRouter);
app.use("/api/admin", adminRouter);
app.use("/api/calls", callsRouter);
app.use("/api/moderation", moderationRouter);
app.use("/api/mentions", mentionsRouter);

app.use(errorHandler);

const server = http.createServer(app);
initSockets(server);

server.listen(env.port, () => {
  console.log(`forego backend listening on :${env.port} (${env.nodeEnv})`);
  startEmailWorker();
  startMaintenance();
});
