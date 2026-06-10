/**
 * webhooks.scopes-update.tsx
 *
 * Handles app/scopes_update webhook.
 * Updates the session's scope record to stay in sync with the granted scopes.
 */

import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic, payload } = await authenticate.webhook(request);

  console.log(`Webhook received: ${topic} for shop ${shop}`);

  // Update the session's scopes field if the session exists
  if (session) {
    const newScopes = (payload as { current_granted_scopes?: string[] })
      ?.current_granted_scopes;
    if (newScopes) {
      await db.session.updateMany({
        where: { shop },
        data: { scope: newScopes.join(",") },
      });
    }
  }

  return new Response(null, { status: 200 });
};
