import crypto from "crypto";
import { config } from "../src/config";

/**
 * End-to-end simulation script.
 * Tests:
 * 1. Shopify orders/paid webhook ingestion with genuine HMAC signature.
 * 2. Duplicate webhook detection (idempotency check).
 * 3. OMS status update ingestion with Bearer authentication.
 * 4. Audit sync-status verification.
 *
 * Usage:
 *   npx tsx scripts/simulate-webhook.ts
 */

const BASE_URL = `http://localhost:${config.port}`;
const webhookSecret = config.shopify.webhookSecret;

async function runSimulation() {
  console.log("==================================================");
  console.log("   Shopify <-> OMS Integration End-to-End Test    ");
  console.log("==================================================\n");

  const testOrderId = `987654321`;
  const orderNumber = `#1099`;
  const webhookId = `wh-test-${Date.now()}`;

  // 1. Prepare sample Shopify orders/paid payload
  const samplePayload = {
    id: testOrderId,
    admin_graphql_api_id: `gid://shopify/Order/${testOrderId}`,
    name: orderNumber,
    email: "customer@example.com",
    total_price: "98.00",
    currency: "USD",
    line_items: [
      {
        id: 111,
        sku: "ABC-001",
        quantity: 2,
        price: "49.00",
      },
    ],
  };

  const payloadString = JSON.stringify(samplePayload);

  // 2. Compute valid HMAC signature
  const hmac = crypto
    .createHmac("sha256", webhookSecret)
    .update(Buffer.from(payloadString))
    .digest("base64");

  console.log(`[Step 1] Sending Shopify 'orders/paid' webhook...`);
  console.log(`Order ID: ${testOrderId} (${orderNumber})`);
  console.log(`Webhook ID: ${webhookId}`);

  try {
    const webhookRes = await fetch(`${BASE_URL}/webhooks/orders-paid`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Topic": "orders/paid",
        "X-Shopify-Hmac-Sha256": hmac,
        "X-Shopify-Shop-Domain": config.shopify.storeDomain,
        "X-Shopify-Webhook-Id": webhookId,
      },
      body: payloadString,
    });

    const webhookResult = await webhookRes.json();
    console.log(`Response Status: ${webhookRes.status}`);
    console.log(`Response Body:  `, webhookResult);

    if (!webhookRes.ok) {
      console.error("❌ Failed step 1.");
      return;
    }

    // 3. Test Duplicate Webhook
    console.log(`\n[Step 2] Sending duplicate webhook with same Webhook ID...`);
    const duplicateRes = await fetch(`${BASE_URL}/webhooks/orders-paid`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Topic": "orders/paid",
        "X-Shopify-Hmac-Sha256": hmac,
        "X-Shopify-Shop-Domain": config.shopify.storeDomain,
        "X-Shopify-Webhook-Id": webhookId, // Same ID
      },
      body: payloadString,
    });

    const dupResult = await duplicateRes.json();
    console.log(`Response Status: ${duplicateRes.status}`);
    console.log(`Response Body:  `, dupResult);
    console.log(`Idempotency check: ${dupResult.message === "Webhook already processed" ? "✅ PASSED (Skipped duplicate)" : "⚠️ CHECK"}`);

    // 4. Test Flow 2: OMS Update
    console.log(`\n[Step 3] Simulating OMS status callback to /oms/updates...`);
    const omsUpdatePayload = {
      shopify_order_id: testOrderId,
      status: "processing",
      external_order_id: "OMS-78432",
    };

    const omsRes = await fetch(`${BASE_URL}/oms/updates`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.oms.apiKey}`,
      },
      body: JSON.stringify(omsUpdatePayload),
    });

    const omsResult = await omsRes.json();
    console.log(`Response Status: ${omsRes.status}`);
    console.log(`Response Body:  `, omsResult);

    // 5. Query Audit / Sync Status
    console.log(`\n[Step 4] Querying sync audit trail for order ${testOrderId}...`);
    const statusRes = await fetch(`${BASE_URL}/oms/sync-status/${testOrderId}`);
    const statusResult = await statusRes.json();
    console.log(`Sync status response:`, JSON.stringify(statusResult, null, 2));

    console.log("\n==================================================");
    console.log("           End-to-End Test Complete!              ");
    console.log("==================================================");
  } catch (err: any) {
    console.error("❌ Error running simulation:", err.message);
    console.log("\n💡 Make sure both the Integration Server (port 3000) and Redis are running!");
  }
}

runSimulation();
