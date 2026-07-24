import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
export function buildReadingLightWorker() {
  return build({ absWorkingDir: root, entryPoints: ["src/server/readingAsync/readingLightWorkerLambda.ts"], outfile: "dist/reading-light-worker/index.mjs", bundle: true, packages: "external", format: "esm", platform: "node", target: "node22", sourcemap: false, legalComments: "none", metafile: true, logLevel: "info" });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await buildReadingLightWorker();
