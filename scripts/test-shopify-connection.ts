import { config } from "../src/config";

async function testShopifyConnection() {
  console.log("Testing Shopify GraphQL Connection...");
  console.log("Domain:", config.shopify.storeDomain);
  console.log("API Version:", config.shopify.apiVersion);

  const endpoint = `https://${config.shopify.storeDomain}/admin/api/${config.shopify.apiVersion}/graphql.json`;
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": config.shopify.accessToken,
      },
      body: JSON.stringify({
        query: `{ shop { name myshopifyDomain email } }`,
      }),
    });

    console.log("Status:", res.status, res.statusText);
    const body = await res.json();
    console.log("Response:", JSON.stringify(body, null, 2));
  } catch (err) {
    console.error("Connection failed:", err);
  }
}

testShopifyConnection();
