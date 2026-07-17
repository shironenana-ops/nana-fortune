import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
export async function buildReadingFoundation() {
  return build({
    absWorkingDir: root,
    entryPoints: ["src/server/readingServerFoundation.ts"],
    outfile: "dist/reading-server-foundation/index.mjs",
    bundle: true,
    packages: "external",
    format: "esm",
    platform: "node",
    target: "node22",
    sourcemap: false,
    legalComments: "none",
    metafile: true,
    logLevel: "info",
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await buildReadingFoundation();
