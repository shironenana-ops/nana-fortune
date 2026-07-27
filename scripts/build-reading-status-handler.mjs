import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
export async function buildReadingStatusHandler() {
  return build({
    absWorkingDir: root,
    entryPoints: ["src/server/readingStatus/readingStatusLambda.ts"],
    outfile: "dist/reading-status-handler/index.mjs",
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
if (process.argv[1] === fileURLToPath(import.meta.url)) await buildReadingStatusHandler();
