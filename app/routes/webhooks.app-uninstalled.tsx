/**
 * webhooks.app-uninstalled.tsx
 *
 * Handles the app/uninstalled webhook.  On uninstall we delete all sessions
 * for the shop from our session storage.  We do not attempt to delete the
 * Shopify discount because the shop's access token is revoked at this point.
 */

import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Webhook received: ${topic} for shop ${shop}`);

  // Always delete all sessions for this shop regardless of whether an
  // individual session object was returned. authenticate.webhook() may return
  // session:null for uninstall payloads when the access token is already
  // revoked, but the shop string is always populated.
  await db.session.deleteMany({ where: { shop } });

  return new Response(null, { status: 200 });
};
