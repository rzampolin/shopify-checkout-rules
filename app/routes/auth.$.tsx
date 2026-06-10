/**
 * auth.$.tsx — Catch-all auth route
 *
 * Handles the OAuth callback and login flows via the Shopify app template
 * authenticate.admin() method.
 */

import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};
