/**
 * webhooks.customers-data-request.tsx
 *
 * Mandatory GDPR compliance webhook — customers/data_request.
 *
 * This app stores NO customer PII (no customer IDs, emails, or addresses).
 * Sessions contain only Shopify shop domains and access tokens.
 * Response: 200 OK with no-op body.
 */

import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop } = await authenticate.webhook(request);
  console.log(`Webhook received: ${topic} for shop ${shop} — no PII stored, no-op`);
  // No PII stored — nothing to return.
  return new Response(null, { status: 200 });
};
