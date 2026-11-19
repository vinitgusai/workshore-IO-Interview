import express from "express";
import { logger } from "../lib/logger";

const app = express();
app.use(express.json());

// ----- In-memory store for mocked OMS orders -----

interface OmsOrder {
  external_order_id: string;
  shopify_order_id: string;
  status: string;
  items: any[];
  total: number;
  currency: string;
  created_at: string;
  updated_at: string;
}

const orders = new Map<string, OmsOrder>();
let orderCounter = 78000; // Starting OMS order number

// ----- Configurable failure simulation -----

let failureMode: "none" | "error_500" | "timeout" = "none";

/**
 * POST /api/orders
 *
 * Create a new order in the OMS.
 * Supports idempotency via X-Idempotency-Key header or shopify_order_id.
 */
app.post("/api/orders", (req, res) => {
  const idempotencyKey =
    req.get("X-Idempotency-Key") || req.body.shopify_order_id;

  logger.info("[Mock OMS] Received order creation request", {
    shopifyOrderId: req.body.shopify_order_id,
    idempotencyKey,
    failureMode,
  });

  // --- Simulate failures ---
  if (failureMode === "error_500") {
    logger.warn("[Mock OMS] Simulating 500 error");
    res.status(500).json({ error: "Internal Server Error (simulated)" });
    return;
  }

  if (failureMode === "timeout") {
    logger.warn("[Mock OMS] Simulating timeout (30s)");
    // Don't respond — simulate timeout
    return;
  }

  // --- Idempotency check ---
  // If this shopify_order_id was already processed, return existing order
  for (const [, order] of orders) {
    if (order.shopify_order_id === req.body.shopify_order_id) {
      logger.info("[Mock OMS] Order already exists, returning existing", {
        omsOrderId: order.external_order_id,
      });
      res.status(200).json({
        external_order_id: order.external_order_id,
        status: order.status,
        message: "Order already exists",
      });
      return;
    }
  }

  // --- Create new order ---
  orderCounter++;
  const externalOrderId = `OMS-${orderCounter}`;
  const newOrder: OmsOrder = {
    external_order_id: externalOrderId,
    shopify_order_id: req.body.shopify_order_id,
    status: "received",
    items: req.body.items || [],
    total: req.body.total || 0,
    currency: req.body.currency || "USD",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  orders.set(externalOrderId, newOrder);

  logger.info("[Mock OMS] Order created", {
    omsOrderId: externalOrderId,
    shopifyOrderId: req.body.shopify_order_id,
  });

  res.status(201).json({
    external_order_id: externalOrderId,
    status: "received",
    message: "Order created successfully",
  });
});

/**
 * GET /api/orders/shopify/:shopifyOrderId
 *
 * Look up an OMS order by its Shopify order ID.
 * Used for idempotency checking by the integration layer.
 */
app.get("/api/orders/shopify/:shopifyOrderId", (req, res) => {
  const { shopifyOrderId } = req.params;

  for (const [, order] of orders) {
    if (order.shopify_order_id === shopifyOrderId) {
      res.json({
        external_order_id: order.external_order_id,
        status: order.status,
      });
      return;
    }
  }

  res.status(404).json({ error: "Order not found" });
});

/**
 * GET /api/orders/:externalOrderId
 *
 * Get an order by its OMS ID.
 */
app.get("/api/orders/:externalOrderId", (req, res) => {
  const order = orders.get(req.params.externalOrderId);
  if (!order) {
    res.status(404).json({ error: "Order not found" });
    return;
  }
  res.json(order);
});

/**
 * GET /api/orders
 *
 * List all orders in the OMS.
 */
app.get("/api/orders", (_req, res) => {
  res.json({
    orders: Array.from(orders.values()),
    total: orders.size,
  });
});

/**
 * PATCH /api/orders/:externalOrderId/status
 *
 * Update order status (simulates OMS processing).
 */
app.patch("/api/orders/:externalOrderId/status", (req, res) => {
  const order = orders.get(req.params.externalOrderId);
  if (!order) {
    res.status(404).json({ error: "Order not found" });
    return;
  }

  order.status = req.body.status || order.status;
  order.updated_at = new Date().toISOString();

  logger.info("[Mock OMS] Order status updated", {
    omsOrderId: order.external_order_id,
    newStatus: order.status,
  });

  // Optionally notify the integration callback endpoint.
  const callbackUrl = process.env.OMS_CALLBACK_URL;
  if (callbackUrl) {
    void fetch(callbackUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OMS_API_KEY || ""}`,
      },
      body: JSON.stringify({
        shopify_order_id: order.shopify_order_id,
        status: order.status,
        external_order_id: order.external_order_id,
      }),
      signal: AbortSignal.timeout(10_000),
    }).catch((error) => {
      logger.warn("[Mock OMS] Failed to send status callback", { error });
    });
  }

  res.json(order);
});

/**
 * POST /api/admin/failure-mode
 *
 * Set the failure simulation mode for testing.
 * - none: Normal operation
 * - error_500: Return 500 for all order creation requests
 * - timeout: Don't respond (simulate network timeout)
 */
app.post("/api/admin/failure-mode", (req, res) => {
  const { mode } = req.body;
  if (!["none", "error_500", "timeout"].includes(mode)) {
    res.status(400).json({
      error: "Invalid mode. Use: none, error_500, timeout",
    });
    return;
  }

  failureMode = mode;
  logger.info("[Mock OMS] Failure mode set", { mode });
  res.json({ message: `Failure mode set to: ${mode}` });
});

/**
 * GET /api/admin/stats
 *
 * Get OMS statistics.
 */
app.get("/api/admin/stats", (_req, res) => {
  res.json({
    totalOrders: orders.size,
    failureMode,
    orders: Array.from(orders.values()).map((o) => ({
      external_order_id: o.external_order_id,
      shopify_order_id: o.shopify_order_id,
      status: o.status,
    })),
  });
});

// ----- Start server -----

const OMS_PORT = parseInt(process.env.OMS_PORT || "3001", 10);

app.listen(OMS_PORT, () => {
  logger.info(`Mock OMS server running on http://localhost:${OMS_PORT}`);
  logger.info("Available endpoints:");
  logger.info("  POST   /api/orders                        - Create order");
  logger.info("  GET    /api/orders                        - List orders");
  logger.info(
    "  GET    /api/orders/shopify/:id            - Find by Shopify ID"
  );
  logger.info("  GET    /api/orders/:id                    - Get order");
  logger.info("  PATCH  /api/orders/:id/status             - Update status");
  logger.info(
    "  POST   /api/admin/failure-mode            - Set failure simulation"
  );
  logger.info("  GET    /api/admin/stats                   - Get stats");
});

export default app;
