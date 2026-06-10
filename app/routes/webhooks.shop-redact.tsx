/**
 * webhooks.shop-redact.tsx
 *
 * Mandatory GDPR compliance webhook — shop/redact.
 *
 * Sent 48 hours after a shop uninstalls the app.  We delete any remaining
 * sessions for the shop (the uninstalled webhook may have already done this).
 * No other PII is stored.
 */

import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop } = await authenticate.webhook(request);
  console.log(`Webhook received: ${topic} for shop ${shop} — deleting sessions`);

  // Delete any lingering sessions for the shop
  await db.session.deleteMany({ where: { shop } });

  return new Response(null, { status: 200 });
};
