import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

export async function buildStagingMembershipStatus() {
  return build({
    absWorkingDir: root,
    entryPoints: ["src/server/stagingAuth/membershipStatusLambda.ts"],
    outfile: "dist/staging-membership-status/index.mjs",
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

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildStagingMembershipStatus();
