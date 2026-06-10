// @ts-check

import { defineConfig } from "astro/config";
import mdx from "@astrojs/mdx";
import sitemap from "@astrojs/sitemap";
import vercel from "@astrojs/vercel/serverless";

export default defineConfig({
  site: "https://nana-fortune.vercel.app",
  output: "server",
  adapter: vercel(),
  integrations: [mdx(), sitemap()],
});