import { Queue, QueueEvents } from "bullmq";
import IORedis from "ioredis";
import { config } from "../config";
import { logger } from "./logger";

// ----- Redis connection -----

export const redisConnection = new IORedis({
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
  maxRetriesPerRequest: null, // Required by BullMQ
});

redisConnection.on("error", (err) => {
  logger.error("Redis connection error", { error: err.message });
});

redisConnection.on("connect", () => {
  logger.info("Connected to Redis");
});

// ----- Queue definitions -----

/**
 * Queue for sending Shopify orders to the OMS.
 * Jobs are retried with exponential backoff on failure.
 */
export const omsOrderQueue = new Queue("oms-order-sync", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 5,
    backoff: {
      type: "exponential",
      delay: 30_000, // Start at 30 seconds, doubles each retry
    },
    removeOnComplete: {
      age: 24 * 3600, // Keep completed jobs for 24 hours
      count: 1000,
    },
    removeOnFail: {
      age: 7 * 24 * 3600, // Keep failed jobs for 7 days
    },
  },
});

/**
 * Queue for updating Shopify orders from OMS status changes.
 */
export const shopifyUpdateQueue = new Queue("shopify-order-update", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 10_000,
    },
    removeOnComplete: {
      age: 24 * 3600,
      count: 1000,
    },
    removeOnFail: {
      age: 7 * 24 * 3600,
    },
  },
});

// ----- Queue event listeners -----

const omsQueueEvents = new QueueEvents("oms-order-sync", {
  connection: redisConnection,
});

omsQueueEvents.on("completed", ({ jobId }) => {
  logger.info(`OMS sync job ${jobId} completed`);
});

omsQueueEvents.on("failed", ({ jobId, failedReason }) => {
  logger.error(`OMS sync job ${jobId} failed: ${failedReason}`);
});

// ----- Types for job data -----

export interface OmsOrderJobData {
  syncEventId: string;
  shopifyOrderId: string;
  shopifyOrderGid: string;
  webhookId: string;
}

export interface ShopifyUpdateJobData {
  syncEventId: string;
  shopifyOrderId: string;
  omsStatus: string;
  externalOrderId: string;
}

// ----- Graceful shutdown -----

export async function closeQueues(): Promise<void> {
  logger.info("Closing queues...");
  await omsOrderQueue.close();
  await shopifyUpdateQueue.close();
  await omsQueueEvents.close();
  await redisConnection.quit();
}
