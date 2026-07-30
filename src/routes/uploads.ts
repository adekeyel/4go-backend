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
    const result = await uploadBuffer(req.file.buffer, {
      folder: `forego/${folder}/${req.userId}`,
      resourceType: req.file.mimetype.startsWith("video") ? "video" : "image",
    });
    res.status(201).json(result);
  })
);
