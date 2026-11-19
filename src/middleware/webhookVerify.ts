import crypto from "crypto";
import { Request, Response, NextFunction } from "express";
import { config } from "../config";
import { logger } from "../lib/logger";

/**
 * Middleware to verify Shopify webhook HMAC-SHA256 signatures.
 *
 * Shopify signs each webhook request with the app's API secret.
 * The signature is sent in the X-Shopify-Hmac-Sha256 header.
 *
 * This middleware:
 * 1. Reads the raw body (must be available as req.body Buffer)
 * 2. Computes HMAC-SHA256 using the webhook secret
 * 3. Compares with the provided signature using timing-safe comparison
 * 4. Rejects requests with invalid or missing signatures
 */
export function verifyShopifyWebhook(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const hmacHeader = req.get("X-Shopify-Hmac-Sha256");

  if (!hmacHeader) {
    logger.warn("Webhook rejected: missing HMAC header", {
      ip: req.ip,
      path: req.path,
    });
    res.status(401).json({ error: "Missing HMAC signature" });
    return;
  }

  // req.body should be a Buffer when using express.raw()
  const rawBody = req.body as Buffer;

  if (!Buffer.isBuffer(rawBody)) {
    logger.error(
      "Webhook verification failed: body is not a Buffer. Ensure express.raw() middleware is used."
    );
    res.status(500).json({ error: "Internal server configuration error" });
    return;
  }

  const computedHmac = crypto
    .createHmac("sha256", config.shopify.webhookSecret)
    .update(rawBody)
    .digest("base64");

  // Use timing-safe comparison to prevent timing attacks
  const computedBuffer = Buffer.from(computedHmac, "base64");
  const providedBuffer = Buffer.from(hmacHeader, "base64");

  if (
    computedBuffer.length !== providedBuffer.length ||
    !crypto.timingSafeEqual(computedBuffer, providedBuffer)
  ) {
    logger.warn("Webhook rejected: invalid HMAC signature", {
      ip: req.ip,
      path: req.path,
    });
    res.status(401).json({ error: "Invalid HMAC signature" });
    return;
  }

  logger.debug("Webhook HMAC verified successfully");

  // Parse the raw body as JSON and store on request for downstream handlers
  try {
    (req as any).webhookPayload = JSON.parse(rawBody.toString("utf-8"));
  } catch (err) {
    logger.error("Failed to parse webhook payload as JSON", { error: err });
    res.status(400).json({ error: "Invalid JSON payload" });
    return;
  }

  next();
}
