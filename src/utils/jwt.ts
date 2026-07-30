import jwt from "jsonwebtoken";
import { env } from "@/lib/env";

export interface AccessTokenPayload {
  sub: string; // user id
  type: "access";
}

export interface RefreshTokenPayload {
  sub: string; // user id
  sid: string; // session id (matches a row in the Session table, so it can be revoked)
  type: "refresh";
}

export function signAccessToken(userId: string): string {
  const payload: AccessTokenPayload = { sub: userId, type: "access" };
  return jwt.sign(payload, env.jwtAccessSecret, { expiresIn: env.jwtAccessTtl as jwt.SignOptions["expiresIn"] });
}

export function signRefreshToken(userId: string, sessionId: string): string {
  const payload: RefreshTokenPayload = { sub: userId, sid: sessionId, type: "refresh" };
  return jwt.sign(payload, env.jwtRefreshSecret, { expiresIn: env.jwtRefreshTtl as jwt.SignOptions["expiresIn"] });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const decoded = jwt.verify(token, env.jwtAccessSecret) as AccessTokenPayload;
  if (decoded.type !== "access") throw new Error("Not an access token");
  return decoded;
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  const decoded = jwt.verify(token, env.jwtRefreshSecret) as RefreshTokenPayload;
  if (decoded.type !== "refresh") throw new Error("Not a refresh token");
  return decoded;
}
