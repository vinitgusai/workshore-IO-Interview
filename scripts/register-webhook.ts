import { config } from "../src/config";

/**
 * Script to register the `orders/paid` webhook subscription in Shopify Admin
 * using the Shopify Admin GraphQL API.
 *
 * Usage:
 *   npx tsx scripts/register-webhook.ts <CALLBACK_URL>
 *
 * Example:
 *   npx tsx scripts/register-webhook.ts https://abc123.ngrok-free.app/webhooks/orders-paid
 */

const callbackUrl = process.argv[2];

if (!callbackUrl) {
  console.error("❌ Error: Please provide your public callback URL.");
  console.log("\nUsage:");
  console.log("  npx tsx scripts/register-webhook.ts <CALLBACK_URL>");
  console.log("\nExample (using ngrok or cloudflared tunnel):");
  console.log("  npx tsx scripts/register-webhook.ts https://your-subdomain.ngrok-free.app/webhooks/orders-paid\n");
  process.exit(1);
}

const REGISTER_WEBHOOK_MUTATION = `
  mutation webhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
      userErrors {
        field
        message
      }
      webhookSubscription {
        id
        topic
        endpoint {
          __typename
          ... on WebhookHttpEndpoint {
            callbackUrl
          }
        }
      }
    }
  }
`;

async function registerWebhook() {
  console.log("🚀 Registering Shopify webhook...");
  console.log(`Store: https://${config.shopify.storeDomain}`);
  console.log(`Topic: ORDERS_PAID`);
  console.log(`Target: ${callbackUrl}`);

  const endpoint = `https://${config.shopify.storeDomain}/admin/api/${config.shopify.apiVersion}/graphql.json`;

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": config.shopify.accessToken,
      },
      body: JSON.stringify({
        query: REGISTER_WEBHOOK_MUTATION,
        variables: {
          topic: "ORDERS_PAID",
          webhookSubscription: {
            callbackUrl,
            format: "JSON",
          },
        },
      }),
    });

    const body = (await res.json()) as any;

    if (body.errors) {
      console.error("❌ GraphQL Error:", JSON.stringify(body.errors, null, 2));
      return;
    }

    const { userErrors, webhookSubscription } =
      body.data?.webhookSubscriptionCreate || {};

    if (userErrors && userErrors.length > 0) {
      console.error("❌ Registration user errors:", userErrors);
      return;
    }

    console.log("✅ Webhook registered successfully!");
    console.log(`Subscription ID: ${webhookSubscription?.id}`);
    console.log(`Callback URL:    ${webhookSubscription?.endpoint?.callbackUrl}`);
  } catch (error) {
    console.error("❌ Failed to register webhook:", error);
  }
}

registerWebhook();
