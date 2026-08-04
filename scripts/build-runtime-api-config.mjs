import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

export function buildRuntimeApiConfig() {
  return build({
    absWorkingDir: root,
    entryPoints: ["src/lib/runtimeApiConfig.ts"],
    outfile: "dist/runtime-api-config/index.mjs",
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    sourcemap: false,
    legalComments: "none",
    logLevel: "silent",
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await buildRuntimeApiConfig();
}
