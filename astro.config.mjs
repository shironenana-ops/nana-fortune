// @ts-check

import { defineConfig, envField } from "astro/config";
import mdx from "@astrojs/mdx";
import sitemap from "@astrojs/sitemap";
import vercel from "@astrojs/vercel";

export default defineConfig({
  site: "https://www.nana-fortune.com",
  output: "server",
  adapter: vercel({}),
  security: {
    // fincode TEST returns by cross-site POST to localhost. In dev only,
    // src/middleware.ts applies the normal origin check with one narrow exception.
    checkOrigin: process.env.NODE_ENV !== "development",
  },
  env: {
    schema: {
      FINCODE_TEST_PAYMENT_ENABLED: envField.string({ context: "server", access: "secret", optional: true }),
      FINCODE_TEST_API_BASE: envField.string({ context: "server", access: "secret", optional: true }),
      FINCODE_TEST_SECRET_KEY: envField.string({ context: "server", access: "secret", optional: true }),
      FINCODE_TEST_SHOP_ID: envField.string({ context: "server", access: "secret", optional: true }),
    },
  },
  integrations: [
    mdx(),
    sitemap({
      filter: (page) => {
        const excludedPaths = [
          "/checkout/success",
          "/fincode/test/result",
          "/history",
          "/login",
          "/members",
          "/result",
          "/signup",
          "/premium/voice-processing",
        ];
        const pathname = new URL(page).pathname;

        return !excludedPaths.some((path) => {
          return pathname === path || pathname.startsWith(`${path}/`);
        });
      },
    }),
  ],
});
