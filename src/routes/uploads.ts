import { Router } from "express";
import { requireAuth } from "@/middleware/auth";
import { upload } from "@/middleware/upload";
import { uploadBuffer } from "@/lib/cloudinary";
import { asyncHandler, ApiError } from "@/middleware/errorHandler";

export const uploadsRouter = Router();
uploadsRouter.use(requireAuth);

uploadsRouter.post(
  "/",
  upload.single("file"),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new ApiError(400, "No file provided");
    const folder = typeof req.body.folder === "string" ? req.body.folder : "misc";
    // "auto" lets Cloudinary detect image/video/audio itself — safer than
    // guessing from the mimetype prefix (audio files aren't "video/*" or
    // "image/*", so a manual guess here previously mis-typed voice notes).
    const result = await uploadBuffer(req.file.buffer, {
      folder: `forego/${folder}/${req.userId}`,
      resourceType: "auto",
    });
    res.status(201).json(result);
  })
);
