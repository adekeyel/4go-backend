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
import { paymentsRouter } from "@/routes/payments";
import { adminRouter } from "@/routes/admin";

const app = express();

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

app.use("/api/auth", authRouter);
app.use("/api/profiles", profilesRouter);
app.use("/api/friends", friendsRouter);
app.use("/api/rooms", roomsRouter);
app.use("/api/messages", messagesRouter);
app.use("/api/feed", feedRouter);
app.use("/api/uploads", uploadsRouter);
app.use("/api/wallet", walletRouter);
app.use("/api/payments", paymentsRouter);
app.use("/api/admin", adminRouter);

app.use(errorHandler);

const server = http.createServer(app);
initSockets(server);

server.listen(env.port, () => {
  console.log(`forego backend listening on :${env.port} (${env.nodeEnv})`);
});
