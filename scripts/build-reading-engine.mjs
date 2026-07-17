import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const entryPoint = fileURLToPath(
  new URL("../src/server/shironeEngineServer.ts", import.meta.url),
);
const outfile = fileURLToPath(
  new URL("../dist/reading-engine/index.mjs", import.meta.url),
);

export async function buildReadingEngine() {
  return build({
    absWorkingDir: projectRoot,
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    sourcemap: false,
    legalComments: "none",
    logLevel: "info",
    metafile: true,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildReadingEngine();
}
