import multer from "multer";

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
