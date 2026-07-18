// @ts-check

import { defineConfig } from "astro/config";
import mdx from "@astrojs/mdx";
import sitemap from "@astrojs/sitemap";
import vercel from "@astrojs/vercel";

export default defineConfig({
  site: "https://www.nana-fortune.com",
  output: "server",
  adapter: vercel({}),
  integrations: [
    mdx(),
    sitemap({
      filter: (page) => {
        const excludedPaths = [
          "/checkout/success",
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
