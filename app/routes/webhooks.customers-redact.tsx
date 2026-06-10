/**
 * webhooks.customers-redact.tsx
 *
 * Mandatory GDPR compliance webhook — customers/redact.
 *
 * This app stores NO customer PII. No data deletion is required.
 * Response: 200 OK with no-op body.
 */

import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop } = await authenticate.webhook(request);
  console.log(`Webhook received: ${topic} for shop ${shop} — no PII stored, no-op`);
  return new Response(null, { status: 200 });
};
