import { vitePlugin as remix } from "@remix-run/dev";
import { defineConfig, type UserConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [
    remix({
      ignoredRouteFiles: ["**/.*"],
      future: {
        v3_fetcherPersist: true,
        v3_relativeSplatPath: true,
        v3_throwAbortReason: true,
        v3_lazyRouteDiscovery: true,
        v3_singleFetch: false,
      },
    }),
    tsconfigPaths(),
  ],
  server: {
    port: Number(process.env.PORT || 3000),
    strictPort: true,
  },
  build: {
    assetsInlineLimit: 0,
  },
}) satisfies UserConfig;
