import multer from "multer";

// Memory storage: files land in req.file.buffer, which we stream straight to
// Cloudinary (lib/cloudinary.ts) rather than writing to Railway's ephemeral disk.
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});
