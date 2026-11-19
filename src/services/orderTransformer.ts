import { ShopifyOrder } from "../lib/shopify";

/**
 * OMS order payload structure as defined in the assessment.
 */
export interface OmsOrderPayload {
  shopify_order_id: string;
  order_number: string;
  customer: {
    email: string;
  };
  items: Array<{
    sku: string;
    quantity: number;
    unit_price: number;
  }>;
  total: number;
  currency: string;
}

/**
 * Transform a Shopify order (from GraphQL API) into the OMS payload format.
 *
 * Maps:
 * - legacyResourceId → shopify_order_id
 * - name → order_number
 * - email → customer.email
 * - lineItems → items (with sku, quantity, unit_price)
 * - totalPriceSet → total + currency
 */
export function transformShopifyToOms(order: ShopifyOrder): OmsOrderPayload {
  return {
    shopify_order_id: order.legacyResourceId,
    order_number: order.name,
    customer: {
      email: order.email || "unknown@example.com",
    },
    items: order.lineItems.edges.map(({ node }) => ({
      sku: node.sku || "UNKNOWN",
      quantity: node.quantity,
      unit_price: parseFloat(node.originalUnitPriceSet.shopMoney.amount),
    })),
    total: parseFloat(order.totalPriceSet.shopMoney.amount),
    currency: order.totalPriceSet.shopMoney.currencyCode,
  };
}

/**
 * Transform a minimal webhook payload into the OMS format.
 * Used when the full GraphQL data is not available (fallback).
 */
export function transformWebhookToOms(webhookPayload: any): OmsOrderPayload {
  return {
    shopify_order_id: String(webhookPayload.id),
    order_number: webhookPayload.name || webhookPayload.order_number || "",
    customer: {
      email:
        webhookPayload.email ||
        webhookPayload.contact_email ||
        "unknown@example.com",
    },
    items: (webhookPayload.line_items || []).map((item: any) => ({
      sku: item.sku || "UNKNOWN",
      quantity: item.quantity || 1,
      unit_price: parseFloat(item.price || "0"),
    })),
    total: parseFloat(webhookPayload.total_price || "0"),
    currency: webhookPayload.currency || "USD",
  };
}
