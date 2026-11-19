import { shopifyClient } from "../lib/shopify";
import { logger } from "../lib/logger";

/**
 * OMS update payload received from the OMS webhook.
 */
export interface OmsUpdatePayload {
  shopify_order_id: string;
  status: string;
  external_order_id: string;
}

/**
 * Update a Shopify order based on an OMS status change.
 *
 * Strategy:
 * 1. Store the OMS order ID and status as metafields on the Shopify order.
 *    - Metafields are the recommended way to attach custom data to Shopify resources.
 *    - They're queryable, don't interfere with merchant workflows, and are API-first.
 * 2. Optionally update the order note for quick merchant visibility.
 *
 * Why metafields over tags or note attributes:
 * - Metafields are structured (typed key-value pairs with namespaces)
 * - They support rich types (JSON, strings, numbers)
 * - They're searchable via GraphQL filters
 * - They don't clutter the merchant-visible order notes
 * - They can be surfaced in Shopify Admin via metafield definitions
 */
export async function updateShopifyFromOms(
  update: OmsUpdatePayload
): Promise<void> {
  const orderGid = `gid://shopify/Order/${update.shopify_order_id}`;

  logger.info("Updating Shopify order from OMS", {
    shopifyOrderId: update.shopify_order_id,
    omsOrderId: update.external_order_id,
    omsStatus: update.status,
  });

  // 1. Set metafields with OMS data
  await shopifyClient.setOrderMetafields(orderGid, [
    {
      namespace: "oms_integration",
      key: "external_order_id",
      value: update.external_order_id,
      type: "single_line_text_field",
    },
    {
      namespace: "oms_integration",
      key: "oms_status",
      value: update.status,
      type: "single_line_text_field",
    },
    {
      namespace: "oms_integration",
      key: "last_synced_at",
      value: new Date().toISOString(),
      type: "single_line_text_field",
    },
  ]);

  // 2. Update order note for quick merchant visibility
  await shopifyClient.appendOrderNote(
    orderGid,
    `OMS Status: ${update.status} | OMS Order: ${update.external_order_id} | Updated: ${new Date().toISOString()}`
  );

  logger.info("Shopify order updated successfully", {
    shopifyOrderId: update.shopify_order_id,
  });
}
