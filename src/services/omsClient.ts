import { config } from "../config";
import { logger } from "../lib/logger";
import { OmsOrderPayload } from "./orderTransformer";

/**
 * Response from the OMS API when creating or looking up an order.
 */
export interface OmsCreateResponse {
  external_order_id: string;
  status: string;
  message?: string;
}

/**
 * Client for communicating with the external OMS REST API.
 */
class OmsClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor() {
    this.baseUrl = config.oms.apiUrl;
    this.apiKey = config.oms.apiKey;
  }

  /**
   * Send a new order to the OMS.
   * Uses shopify_order_id as an idempotency key — the OMS should
   * return the existing order if it was already created.
   *
   * @throws Error if the OMS responds with a non-2xx status
   */
  async createOrder(order: OmsOrderPayload): Promise<OmsCreateResponse> {
    const url = `${this.baseUrl}/api/orders`;

    logger.info("Sending order to OMS", {
      shopifyOrderId: order.shopify_order_id,
      url,
    });

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        "X-Idempotency-Key": order.shopify_order_id, // Prevents duplicate creation
      },
      body: JSON.stringify(order),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`OMS API error (${response.status}): ${errorBody}`);
    }

    const data = (await response.json()) as OmsCreateResponse;

    logger.info("OMS order created/found", {
      shopifyOrderId: order.shopify_order_id,
      omsOrderId: data.external_order_id,
    });

    return data;
  }

  /**
   * Check if an order already exists in the OMS by Shopify order ID.
   * Useful for checking before retry to prevent duplicates.
   */
  async getOrderByShopifyId(
    shopifyOrderId: string
  ): Promise<OmsCreateResponse | null> {
    const url = `${this.baseUrl}/api/orders/shopify/${shopifyOrderId}`;

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });

      if (response.status === 404) {
        return null;
      }

      if (!response.ok) {
        throw new Error(`OMS API error (${response.status})`);
      }

      return (await response.json()) as OmsCreateResponse;
    } catch (error) {
      logger.warn("Failed to check existing OMS order", {
        shopifyOrderId,
        error,
      });
      return null;
    }
  }
}

export const omsClient = new OmsClient();
