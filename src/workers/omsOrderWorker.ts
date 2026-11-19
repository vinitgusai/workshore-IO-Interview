import { Worker, Job } from "bullmq";
import {
  redisConnection,
  OmsOrderJobData,
  ShopifyUpdateJobData,
} from "../lib/queue";
import { prisma } from "../lib/prisma";
import { shopifyClient } from "../lib/shopify";
import { transformShopifyToOms } from "../services/orderTransformer";
import { omsClient } from "../services/omsClient";
import { updateShopifyFromOms } from "../services/shopifyUpdater";
import { logger } from "../lib/logger";

/**
 * Worker that processes Shopify → OMS order sync jobs.
 *
 * Flow:
 * 1. Fetch full order details from Shopify GraphQL API
 * 2. Transform into OMS payload format
 * 3. Check if order already exists in OMS (idempotency for partial failures)
 * 4. Send to OMS if not already there
 * 5. Update sync event status in database
 */
export const omsOrderWorker = new Worker<OmsOrderJobData>(
  "oms-order-sync",
  async (job: Job<OmsOrderJobData>) => {
    const { syncEventId, shopifyOrderId, shopifyOrderGid, webhookId } =
      job.data;

    logger.info("Processing OMS order sync job", {
      jobId: job.id,
      shopifyOrderId,
      attempt: job.attemptsMade + 1,
    });

    try {
      // Update status to PROCESSING
      await prisma.syncEvent.update({
        where: { id: syncEventId },
        data: { status: "PROCESSING", retryCount: job.attemptsMade },
      });

      // --- Partial failure protection ---
      // Before creating in OMS, check if it already exists.
      // This handles the case where OMS created the order but our app
      // crashed before recording the success.
      const existingOrder =
        await omsClient.getOrderByShopifyId(shopifyOrderId);

      if (existingOrder) {
        logger.info("Order already exists in OMS, skipping creation", {
          shopifyOrderId,
          omsOrderId: existingOrder.external_order_id,
        });

        // Record the successful sync
        await prisma.syncEvent.update({
          where: { id: syncEventId },
          data: {
            status: "SYNCED",
            omsOrderId: existingOrder.external_order_id,
          },
        });
        return;
      }

      // Fetch full order details from Shopify
      const shopifyOrder = await shopifyClient.getOrder(shopifyOrderGid);

      // Transform to OMS format
      const omsPayload = transformShopifyToOms(shopifyOrder);

      // Send to OMS
      const omsResponse = await omsClient.createOrder(omsPayload);

      // Record successful sync
      await prisma.syncEvent.update({
        where: { id: syncEventId },
        data: {
          status: "SYNCED",
          omsOrderId: omsResponse.external_order_id,
        },
      });

      logger.info("Order synced to OMS successfully", {
        shopifyOrderId,
        omsOrderId: omsResponse.external_order_id,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      logger.error("OMS sync job failed", {
        jobId: job.id,
        shopifyOrderId,
        attempt: job.attemptsMade + 1,
        error: errorMessage,
      });

      // Update the sync event with the error
      await prisma.syncEvent.update({
        where: { id: syncEventId },
        data: {
          status: "FAILED",
          errorMessage,
          retryCount: job.attemptsMade + 1,
        },
      });

      // Re-throw to trigger BullMQ retry
      throw error;
    }
  },
  {
    connection: redisConnection,
    concurrency: 2, // Process 2 jobs at a time (helps with rate limits)
    limiter: {
      max: 10, // Max 10 jobs
      duration: 60_000, // Per minute — prevents overwhelming OMS
    },
  }
);

/**
 * Worker that processes OMS → Shopify update jobs.
 */
export const shopifyUpdateWorker = new Worker<ShopifyUpdateJobData>(
  "shopify-order-update",
  async (job: Job<ShopifyUpdateJobData>) => {
    const { syncEventId, shopifyOrderId, omsStatus, externalOrderId } =
      job.data;

    logger.info("Processing Shopify update job", {
      jobId: job.id,
      shopifyOrderId,
      omsStatus,
    });

    try {
      await prisma.syncEvent.update({
        where: { id: syncEventId },
        data: { status: "PROCESSING" },
      });

      await updateShopifyFromOms({
        shopify_order_id: shopifyOrderId,
        status: omsStatus,
        external_order_id: externalOrderId,
      });

      await prisma.syncEvent.update({
        where: { id: syncEventId },
        data: { status: "SYNCED" },
      });

      logger.info("Shopify order updated from OMS successfully", {
        shopifyOrderId,
        omsStatus,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      logger.error("Shopify update job failed", {
        jobId: job.id,
        shopifyOrderId,
        error: errorMessage,
      });

      await prisma.syncEvent.update({
        where: { id: syncEventId },
        data: {
          status: "FAILED",
          errorMessage,
          retryCount: job.attemptsMade + 1,
        },
      });

      throw error;
    }
  },
  {
    connection: redisConnection,
    concurrency: 2,
  }
);

// ----- Worker event listeners -----

omsOrderWorker.on("ready", () => {
  logger.info("OMS order worker is ready");
});

shopifyUpdateWorker.on("ready", () => {
  logger.info("Shopify update worker is ready");
});

// ----- Graceful shutdown -----

export async function closeWorkers(): Promise<void> {
  logger.info("Closing workers...");
  await omsOrderWorker.close();
  await shopifyUpdateWorker.close();
}
