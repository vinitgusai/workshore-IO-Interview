import { Router, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { shopifyUpdateQueue, ShopifyUpdateJobData } from "../lib/queue";
import { config } from "../config";
import { logger } from "../lib/logger";

const router = Router();

/**
 * Middleware to verify OMS API key authentication.
 * The OMS must send its API key in the Authorization header.
 */
function verifyOmsAuth(
  req: Request,
  res: Response,
  next: Function
): void {
  const authHeader = req.get("Authorization");
  const expectedToken = `Bearer ${config.oms.apiKey}`;

  if (!authHeader || authHeader !== expectedToken) {
    logger.warn("OMS update rejected: invalid authentication", {
      ip: req.ip,
    });
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
}

/**
 * POST /oms/updates
 *
 * Receives status updates from the external OMS and syncs them to Shopify.
 *
 * Expected payload:
 * {
 *   "shopify_order_id": "123456789",
 *   "status": "processing",
 *   "external_order_id": "OMS-78432"
 * }
 *
 * Flow:
 * 1. Validate the incoming payload
 * 2. Create a SyncEvent record
 * 3. Enqueue a Shopify update job
 * 4. The worker will update Shopify via metafields + order note
 */
router.post(
  "/updates",
  verifyOmsAuth,
  async (req: Request, res: Response) => {
    try {
      const { shopify_order_id, status, external_order_id } = req.body;

      // --- Validate required fields ---
      if (!shopify_order_id || !status || !external_order_id) {
        res.status(400).json({
          error:
            "Missing required fields: shopify_order_id, status, external_order_id",
        });
        return;
      }

      if (
        typeof shopify_order_id !== "string" &&
        typeof shopify_order_id !== "number"
      ) {
        res.status(400).json({ error: "Invalid shopify_order_id" });
        return;
      }

      if (typeof status !== "string" || typeof external_order_id !== "string") {
        res.status(400).json({
          error: "status and external_order_id must be strings",
        });
        return;
      }

      logger.info("Received OMS update", {
        shopifyOrderId: shopify_order_id,
        status,
        externalOrderId: external_order_id,
      });

      // A repeated delivery for the same OMS order/status is the same event.
      const webhookId = `oms-update-${external_order_id}-${status}`;
      const existing = await prisma.syncEvent.findUnique({
        where: { webhookId },
      });

      if (existing) {
        res.status(200).json({
          message: "OMS update already processed",
          syncEventId: existing.id,
        });
        return;
      }

      // --- Create sync event ---
      const syncEvent = await prisma.syncEvent.create({
        data: {
          shopifyOrderId: String(shopify_order_id),
          omsOrderId: external_order_id,
          webhookId,
          direction: "OMS_TO_SHOPIFY",
          status: "RECEIVED",
          payload: JSON.stringify(req.body),
        },
      });

      // --- Enqueue Shopify update job ---
      const jobData: ShopifyUpdateJobData = {
        syncEventId: syncEvent.id,
        shopifyOrderId: String(shopify_order_id),
        omsStatus: status,
        externalOrderId: external_order_id,
      };

      await shopifyUpdateQueue.add(
        `shopify-update-${shopify_order_id}`,
        jobData,
        {
          jobId: `shopify-update-${webhookId}`,
        }
      );

      logger.info("OMS update queued for Shopify sync", {
        syncEventId: syncEvent.id,
        shopifyOrderId: shopify_order_id,
      });

      res.status(200).json({
        message: "Update received and queued",
        syncEventId: syncEvent.id,
      });
    } catch (error) {
      logger.error("Error processing OMS update", { error });
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

/**
 * GET /oms/sync-status/:shopifyOrderId
 *
 * Utility endpoint to check the sync status of an order.
 * Useful for debugging and monitoring.
 */
router.get(
  "/sync-status/:shopifyOrderId",
  async (req: Request, res: Response) => {
    try {
      const shopifyOrderId = req.params.shopifyOrderId as string;

      const events = await prisma.syncEvent.findMany({
        where: { shopifyOrderId },
        orderBy: { createdAt: "desc" },
      });

      res.json({
        shopifyOrderId,
        totalEvents: events.length,
        events: events.map((e) => ({
          id: e.id,
          direction: e.direction,
          status: e.status,
          omsOrderId: e.omsOrderId,
          retryCount: e.retryCount,
          errorMessage: e.errorMessage,
          createdAt: e.createdAt,
          updatedAt: e.updatedAt,
        })),
      });
    } catch (error) {
      logger.error("Error fetching sync status", { error });
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

export default router;
