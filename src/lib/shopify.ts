import { config } from "../config";
import { logger } from "./logger";

// ----- Types for Shopify GraphQL responses -----

export interface ShopifyOrderLineItem {
  sku: string | null;
  quantity: number;
  originalUnitPriceSet: {
    shopMoney: {
      amount: string;
      currencyCode: string;
    };
  };
}

export interface ShopifyOrder {
  id: string; // GID e.g. "gid://shopify/Order/123456789"
  name: string; // e.g. "#1001"
  legacyResourceId: string; // numeric ID e.g. "123456789"
  email: string | null;
  totalPriceSet: {
    shopMoney: {
      amount: string;
      currencyCode: string;
    };
  };
  lineItems: {
    edges: Array<{
      node: ShopifyOrderLineItem;
    }>;
  };
  metafields: {
    edges: Array<{
      node: {
        namespace: string;
        key: string;
        value: string;
      };
    }>;
  };
}

// ----- GraphQL query to fetch order details -----

const ORDER_QUERY = `
  query GetOrder($id: ID!) {
    order(id: $id) {
      id
      name
      legacyResourceId
      email
      totalPriceSet {
        shopMoney {
          amount
          currencyCode
        }
      }
      lineItems(first: 50) {
        edges {
          node {
            sku
            quantity
            originalUnitPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
          }
        }
      }
      metafields(first: 10, namespace: "oms_integration") {
        edges {
          node {
            namespace
            key
            value
          }
        }
      }
    }
  }
`;

// ----- Mutation to add a metafield (for OMS status/ID) -----

const METAFIELD_SET_MUTATION = `
  mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
        namespace
        key
        value
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// ----- Mutation to add an order note -----

const ORDER_UPDATE_MUTATION = `
  mutation OrderUpdate($input: OrderInput!) {
    orderUpdate(input: $input) {
      order {
        id
        note
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const ORDER_NOTE_QUERY = `
  query GetOrderNote($id: ID!) {
    order(id: $id) {
      id
      note
    }
  }
`;

// ----- Shopify Admin GraphQL client -----

class ShopifyClient {
  private readonly endpoint: string;
  private readonly headers: Record<string, string>;

  constructor() {
    this.endpoint = `https://${config.shopify.storeDomain}/admin/api/${config.shopify.apiVersion}/graphql.json`;
    this.headers = {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": config.shopify.accessToken,
    };
  }

  /**
   * Execute a GraphQL query/mutation against the Shopify Admin API.
   * Handles basic rate-limit backoff using the cost information.
   */
  async query<T = any>(
    queryStr: string,
    variables: Record<string, any> = {}
  ): Promise<T> {
    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({ query: queryStr, variables }),
      });

      // Handle rate limiting (HTTP 429 or Shopify throttling)
      if (response.status === 429) {
        const retryAfter = parseFloat(
          response.headers.get("Retry-After") || "2"
        );
        logger.warn(
          `Shopify rate limit hit, retrying in ${retryAfter}s (attempt ${attempt}/${maxRetries})`
        );
        await this.sleep(retryAfter * 1000);
        continue;
      }

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(
          `Shopify API error (${response.status}): ${errorBody}`
        );
      }

      const json = (await response.json()) as any;

      // Check for throttling in GraphQL response extensions
      if (json.extensions?.cost?.throttleStatus?.currentlyAvailable < 100) {
        logger.warn("Shopify API points low, adding delay...");
        await this.sleep(1000);
      }

      if (json.errors) {
        // Check for THROTTLED error
        const throttled = json.errors.some(
          (e: any) => e.extensions?.code === "THROTTLED"
        );
        if (throttled && attempt < maxRetries) {
          logger.warn(
            `Shopify GraphQL throttled, retrying (attempt ${attempt}/${maxRetries})`
          );
          await this.sleep(2000 * attempt);
          continue;
        }
        throw new Error(
          `Shopify GraphQL errors: ${JSON.stringify(json.errors)}`
        );
      }

      return json.data as T;
    }

    throw new Error("Shopify API: max retries exceeded");
  }

  /**
   * Fetch a full order by its GID.
   */
  async getOrder(orderGid: string): Promise<ShopifyOrder> {
    const data = await this.query<{ order: ShopifyOrder }>(ORDER_QUERY, {
      id: orderGid,
    });
    return data.order;
  }

  /**
   * Set metafields on an order (e.g., OMS order ID, sync status).
   */
  async setOrderMetafields(
    orderGid: string,
    metafields: Array<{
      namespace: string;
      key: string;
      value: string;
      type: string;
    }>
  ): Promise<void> {
    const input = metafields.map((mf) => ({
      ownerId: orderGid,
      ...mf,
    }));

    const data = await this.query(METAFIELD_SET_MUTATION, {
      metafields: input,
    });

    if (data.metafieldsSet?.userErrors?.length > 0) {
      throw new Error(
        `Metafield errors: ${JSON.stringify(data.metafieldsSet.userErrors)}`
      );
    }
  }

  /**
   * Update the order note.
   */
  async updateOrderNote(orderGid: string, note: string): Promise<void> {
    const data = await this.query(ORDER_UPDATE_MUTATION, {
      input: { id: orderGid, note },
    });

    if (data.orderUpdate?.userErrors?.length > 0) {
      throw new Error(
        `Order update errors: ${JSON.stringify(data.orderUpdate.userErrors)}`
      );
    }
  }

  async appendOrderNote(orderGid: string, noteLine: string): Promise<void> {
    const data = await this.query<{ order: { note: string | null } }>(
      ORDER_NOTE_QUERY,
      { id: orderGid }
    );
    const existingNote = data.order?.note?.trim() || "";
    const updatedNote = existingNote
      ? `${existingNote}\n${noteLine}`
      : noteLine;
    await this.updateOrderNote(orderGid, updatedNote);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Export a singleton instance
export const shopifyClient = new ShopifyClient();
