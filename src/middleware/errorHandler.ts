import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { env } from "@/lib/env";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Wrap an async route handler so thrown errors reach errorHandler instead of crashing the process. */
export function asyncHandler<T extends (req: Request, res: Response, next: NextFunction) => Promise<unknown>>(
  fn: T
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: err.message });
  }
  if (err instanceof ZodError) {
    return res.status(400).json({ error: "Invalid request", details: err.flatten() });
  }
  console.error(err);
  return res.status(500).json({ error: env.isProd ? "Internal server error" : String(err) });
}
