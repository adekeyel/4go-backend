import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: required("DATABASE_URL"),

  jwtAccessSecret: required("JWT_ACCESS_SECRET"),
  jwtRefreshSecret: required("JWT_REFRESH_SECRET"),
  jwtAccessTtl: process.env.JWT_ACCESS_TTL ?? "15m",
  jwtRefreshTtl: process.env.JWT_REFRESH_TTL ?? "180d",

  clientOrigins: (process.env.CLIENT_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  siteUrl: process.env.SITE_URL ?? "http://localhost:5173",
  // When true, "forgot password" also needs the account's phone number (if it has one on file).
  requirePhoneForReset: process.env.REQUIRE_PHONE_FOR_RESET === "true",
  // Public base URL of THIS backend (e.g. https://api.4go.com.ng). Used for the unsubscribe links in emails.
  apiUrl: (process.env.PUBLIC_API_URL ?? "").replace(/\/+$/, ""),

  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME ?? "",
    apiKey: process.env.CLOUDINARY_API_KEY ?? "",
    apiSecret: process.env.CLOUDINARY_API_SECRET ?? "",
  },

  resendApiKey: process.env.RESEND_API_KEY ?? "",
  emailFrom: process.env.EMAIL_FROM ?? "forego <notify@notify.4go.com.ng>",

  flutterwave: {
    secretKey: process.env.FLUTTERWAVE_SECRET_KEY ?? "",
    publicKey: process.env.FLUTTERWAVE_PUBLIC_KEY ?? "",
    // The "Secret hash" you set under Settings > Webhooks in the Flutterwave dashboard. Webhooks are refused without it.
    webhookHash: process.env.FLUTTERWAVE_WEBHOOK_HASH ?? "",
  },

  vapid: {
    publicKey: process.env.VAPID_PUBLIC_KEY ?? "",
    privateKey: process.env.VAPID_PRIVATE_KEY ?? "",
    subject: process.env.VAPID_SUBJECT ?? "mailto:support@4go.com.ng",
  },

  // How many reverse proxies sit between the internet and this server (Railway, Cloudflare, ...). Express needs
  // this to see the real visitor address: at 0 every visitor looks like the proxy. Too HIGH a number lets a
  // visitor fake their address, so set it to exactly the number of proxies; open /health/ip to check.
  // Whole numbers only; "true" (trust everything) is deliberately not accepted.
  trustProxy: /^\d+$/.test(process.env.TRUST_PROXY ?? "") ? Number(process.env.TRUST_PROXY) : 0,

  isProd: process.env.NODE_ENV === "production",
};
