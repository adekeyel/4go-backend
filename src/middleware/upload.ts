import multer from "multer";
import { Request, Response, NextFunction } from "express";
import { ApiError } from "@/middleware/errorHandler";

// Memory storage: files land in req.file.buffer, which we stream straight to
// Cloudinary (lib/cloudinary.ts) rather than writing to Railway's ephemeral disk.
// Capped well below the old 1GB client-side check (buffering a full 1GB
// upload in a single request's memory on a typical Railway instance risks
// OOM-killing the process) — 200MB comfortably covers chat photos/voice
// notes/video clips.
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 },
});

// Video ads: admin-only, video files only, 100MB. Ads are short; the cap keeps a single request from
// holding a huge buffer in memory (see the note above).
const AD_VIDEO_MAX_MB = 100;
const adVideoMulter = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: AD_VIDEO_MAX_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) =>
    file.mimetype.startsWith("video/") ? cb(null, true) : cb(new ApiError(400, "Only video files can be uploaded as an ad")),
});

/** Like upload.single(field) but turns multer's size error into a clear 413 instead of a 500. */
export function uploadAdVideo(field: string) {
  const handler = adVideoMulter.single(field);
  return (req: Request, res: Response, next: NextFunction) =>
    handler(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        return next(new ApiError(413, `Ad video must be under ${AD_VIDEO_MAX_MB}MB`));
      }
      next(err);
    });
}
