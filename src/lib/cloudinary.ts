import { v2 as cloudinary } from "cloudinary";
import { env } from "./env";

cloudinary.config({
  cloud_name: env.cloudinary.cloudName,
  api_key: env.cloudinary.apiKey,
  api_secret: env.cloudinary.apiSecret,
  secure: true,
});

/** Upload a buffer (e.g. from multer's memoryStorage) to Cloudinary. */
export function uploadBuffer(
  buffer: Buffer,
  options: { folder: string; resourceType?: "image" | "video" | "auto" }
): Promise<{ url: string; publicId: string; duration?: number }> {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: options.folder, resource_type: options.resourceType ?? "auto" },
      (error, result) => {
        if (error || !result) return reject(error ?? new Error("Cloudinary upload failed"));
        // duration (seconds, fractional) is only present for video/audio assets.
        resolve({
          url: result.secure_url,
          publicId: result.public_id,
          ...(typeof result.duration === "number" ? { duration: result.duration } : {}),
        });
      }
    );
    stream.end(buffer);
  });
}

/** A JPEG still from a Cloudinary video (first frame by default), for ad/video thumbnails. */
export function videoThumbnailUrl(publicId: string): string {
  return cloudinary.url(publicId, { resource_type: "video", format: "jpg", secure: true });
}

export { cloudinary };
