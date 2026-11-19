import dotenv from "dotenv";
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || "3000", 10),
  nodeEnv: process.env.NODE_ENV || "development",

  shopify: {
    storeDomain: process.env.SHOPIFY_STORE_DOMAIN || "",
    apiKey: process.env.SHOPIFY_API_KEY || "",
    apiSecret: process.env.SHOPIFY_API_SECRET || "",
    accessToken: process.env.SHOPIFY_ACCESS_TOKEN || "",
    apiVersion: process.env.SHOPIFY_API_VERSION || "2026-10",
    webhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET || "",
  },

  oms: {
    apiUrl: process.env.OMS_API_URL || "http://localhost:3001",
    apiKey: process.env.OMS_API_KEY || "",
  },

  redis: {
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT || "6379", 10),
    password: process.env.REDIS_PASSWORD || undefined,
  },
} as const;

export type Config = typeof config;
