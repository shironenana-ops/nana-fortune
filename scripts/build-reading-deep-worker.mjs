import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
export function buildReadingDeepWorker() {
  return build({ absWorkingDir: root, entryPoints: ["src/server/readingAsync/readingDeepWorkerLambda.ts"], outfile: "dist/reading-deep-worker/index.mjs", bundle: true, packages: "external", format: "esm", platform: "node", target: "node22", sourcemap: false, legalComments: "none", metafile: true, logLevel: "info" });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await buildReadingDeepWorker();
