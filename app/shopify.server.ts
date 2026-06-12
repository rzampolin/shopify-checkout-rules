import "@shopify/shopify-app-remix/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-remix/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import { boundary } from "@shopify/shopify-app-remix/server";
import prisma from "./db.server";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Dev-only guardrail: warn if .env SHOPIFY_API_KEY overrides the CLI-injected
// key.  @remix-run/dev's Vite plugin does Object.assign(process.env, loadEnv(...))
// so a .env value silently wins over whatever the CLI set, causing the embedded
// auth strategy to see a mismatched client_id and fail with invalid_client.
// ---------------------------------------------------------------------------
if (process.env.NODE_ENV !== "production") {
  try {
    const tomlPath = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "..",
      "shopify.app.toml",
    );
    const tomlText = fs.readFileSync(tomlPath, "utf-8");
    const match = tomlText.match(/client_id\s*=\s*"([^"]+)"/);
    if (match) {
      const tomlClientId = match[1];
      const envKey = process.env.SHOPIFY_API_KEY;
      if (envKey && envKey !== tomlClientId) {
        console.warn(
          "\n" +
            "============================================================\n" +
            "  SHOPIFY_API_KEY MISMATCH — EMBEDDED AUTH WILL BREAK\n" +
            "============================================================\n" +
            `  shopify.app.toml client_id : ${tomlClientId}\n` +
            `  .env SHOPIFY_API_KEY       : ${envKey}\n` +
            "\n" +
            "  The .env value is overriding the Shopify CLI-injected key\n" +
            "  because @remix-run/dev's Vite plugin runs:\n" +
            "    Object.assign(process.env, loadEnv(...))\n" +
            "  which makes .env win over CLI-injected values.\n" +
            "\n" +
            "  FIX: Remove SHOPIFY_API_KEY (and SHOPIFY_API_SECRET) from\n" +
            "  your .env file.  The CLI injects them automatically.\n" +
            "============================================================\n",
        );
      }
    }
  } catch {
    // Missing or unreadable toml — skip the check silently.
  }
}

export { boundary };

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY!,
  apiSecretKey: process.env.SHOPIFY_API_SECRET!,
  apiVersion: ApiVersion.October25,
  // scopes are NOT read from env — they are driven exclusively by
  // shopify.app.toml [access_scopes] (write_discounts,read_products).
  // Providing a scopes override here risks a mismatch with the toml and
  // breaks the new embedded auth strategy's scope-change detection.
  appUrl: process.env.SHOPIFY_APP_URL!,
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  future: {
    unstable_newEmbeddedAuthStrategy: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.October25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
