import express from "express";
import { config } from "./config";
import { logger } from "./lib/logger";
import { prisma } from "./lib/prisma";
import { closeQueues } from "./lib/queue";
import { closeWorkers } from "./workers/omsOrderWorker";
import { verifyShopifyWebhook } from "./middleware/webhookVerify";
import webhookRoutes from "./routes/webhooks";
import omsUpdateRoutes from "./routes/omsUpdates";

const app = express();

// ----- Middleware Setup -----

// Health check (before body parsers)
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Shopify webhook routes need raw body for HMAC verification.
// Use express.raw() for /webhooks/* paths.
app.use(
  "/webhooks",
  express.raw({ type: "application/json" }),
  verifyShopifyWebhook,
  webhookRoutes
);

// OMS update routes use standard JSON parsing.
app.use("/oms", express.json(), omsUpdateRoutes);

// ----- Error handling -----

app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    logger.error("Unhandled error", {
      error: err.message,
      stack: err.stack,
    });
    res.status(500).json({ error: "Internal server error" });
  }
);

// ----- Start server -----

async function start() {
  try {
    // Ensure database is connected and migrated
    await prisma.$connect();
    logger.info("Database connected");

    // Start workers (imported above, they auto-start)
    logger.info("Workers started");

    app.listen(config.port, () => {
      logger.info(
        `Integration server running on http://localhost:${config.port}`
      );
      logger.info("Endpoints:");
      logger.info(
        "  POST /webhooks/orders-paid   - Shopify webhook receiver"
      );
      logger.info(
        "  POST /oms/updates            - OMS status update receiver"
      );
      logger.info(
        "  GET  /oms/sync-status/:id    - Check sync status"
      );
      logger.info("  GET  /health                 - Health check");
    });
  } catch (error) {
    logger.error("Failed to start server", { error });
    process.exit(1);
  }
}

// ----- Graceful shutdown -----

async function shutdown(signal: string) {
  logger.info(`${signal} received. Starting graceful shutdown...`);

  try {
    await closeWorkers();
    await closeQueues();
    await prisma.$disconnect();
    logger.info("Graceful shutdown complete");
    process.exit(0);
  } catch (error) {
    logger.error("Error during shutdown", { error });
    process.exit(1);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

start();

export default app;
