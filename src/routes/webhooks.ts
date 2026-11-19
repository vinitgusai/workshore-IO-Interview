import { Router, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { omsOrderQueue, OmsOrderJobData } from "../lib/queue";
import { logger } from "../lib/logger";

const router = Router();

/**
 * POST /webhooks/orders-paid
 *
 * Handles the Shopify `orders/paid` webhook event.
 *
 * Flow:
 * 1. Extract the webhook ID for idempotency checking
 * 2. Check if this webhook was already processed (duplicate detection)
 * 3. Create a SyncEvent record (RECEIVED status)
 * 4. Enqueue the job for async processing via BullMQ
 * 5. Return 200 immediately (Shopify requires fast responses)
 *
 * Note: HMAC verification is handled by the verifyShopifyWebhook middleware
 * applied in app.ts before this route is reached.
 */
router.post("/orders-paid", async (req: Request, res: Response) => {
  try {
    // The parsed payload is set by the webhook verification middleware
    const payload = (req as any).webhookPayload;
    const webhookId =
      req.get("X-Shopify-Webhook-Id") || `fallback-${Date.now()}`;
    const shopifyOrderId = String(payload.id);
    const shopifyOrderGid =
      payload.admin_graphql_api_id ||
      `gid://shopify/Order/${shopifyOrderId}`;

    logger.info("Received orders/paid webhook", {
      webhookId,
      shopifyOrderId,
      orderNumber: payload.name,
    });

    // --- Duplicate webhook detection ---
    // Shopify may deliver the same webhook more than once.
    // We use the X-Shopify-Webhook-Id header as a unique identifier.
    const existing = await prisma.syncEvent.findUnique({
      where: { webhookId },
    });

    if (existing) {
      logger.warn("Duplicate webhook detected, skipping", {
        webhookId,
        shopifyOrderId,
        existingStatus: existing.status,
      });
      // Return 200 so Shopify doesn't retry
      res.status(200).json({
        message: "Webhook already processed",
        syncEventId: existing.id,
      });
      return;
    }

    // --- Create sync event record ---
    const syncEvent = await prisma.syncEvent.create({
      data: {
        shopifyOrderId,
        shopifyOrderGid,
        webhookId,
        direction: "SHOPIFY_TO_OMS",
        status: "RECEIVED",
        payload: JSON.stringify(payload),
      },
    });

    // --- Enqueue for async processing ---
    // The job will be picked up by the OMS order worker, which will:
    // 1. Fetch full order data from Shopify GraphQL API
    // 2. Transform to OMS format
    // 3. Send to OMS with idempotency protection
    const jobData: OmsOrderJobData = {
      syncEventId: syncEvent.id,
      shopifyOrderId,
      shopifyOrderGid,
      webhookId,
    };

    await omsOrderQueue.add(`order-${shopifyOrderId}`, jobData, {
      // Use shopify order ID as job dedup key
      jobId: `oms-sync-${shopifyOrderId}-${webhookId}`,
    });

    logger.info("Order queued for OMS sync", {
      syncEventId: syncEvent.id,
      shopifyOrderId,
    });

    // Respond quickly — Shopify expects a 200 within 5 seconds
    res.status(200).json({
      message: "Webhook received and queued",
      syncEventId: syncEvent.id,
    });
  } catch (error) {
    logger.error("Error processing orders/paid webhook", { error });

    // Still return 200 for database unique constraint violations (duplicates)
    if (
      error instanceof Error &&
      error.message.includes("Unique constraint")
    ) {
      res.status(200).json({ message: "Duplicate webhook (constraint)" });
      return;
    }

    // For other errors, return 500 so Shopify retries
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
