import assert from "node:assert/strict";
import test from "node:test";
import { transformShopifyToOms } from "../src/services/orderTransformer";
import { ShopifyOrder } from "../src/lib/shopify";

test("transforms a Shopify order to the OMS payload", () => {
  const order: ShopifyOrder = {
    id: "gid://shopify/Order/123",
    name: "#1001",
    legacyResourceId: "123",
    email: "customer@example.com",
    totalPriceSet: {
      shopMoney: { amount: "98.00", currencyCode: "USD" },
    },
    lineItems: {
      edges: [
        {
          node: {
            sku: "ABC-001",
            quantity: 2,
            originalUnitPriceSet: {
              shopMoney: { amount: "49.00", currencyCode: "USD" },
            },
          },
        },
      ],
    },
    metafields: { edges: [] },
  };

  assert.deepEqual(transformShopifyToOms(order), {
    shopify_order_id: "123",
    order_number: "#1001",
    customer: { email: "customer@example.com" },
    items: [{ sku: "ABC-001", quantity: 2, unit_price: 49 }],
    total: 98,
    currency: "USD",
  });
});
