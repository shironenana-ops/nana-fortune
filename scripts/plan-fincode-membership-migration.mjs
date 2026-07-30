import { readFile } from "node:fs/promises";

const [inputPath] = process.argv.slice(2);
if (!inputPath) throw new Error("FINCODE_MIGRATION_INPUT_REQUIRED");
const module = await import("../dist/fincode-webhook-handler/index.mjs");
const input = JSON.parse(await readFile(inputPath, "utf8"));
const results = await module.planFincodeMembershipMigration({ ...input, allowedTargetRefs: new Set(input.allowedTargetRefs ?? []) });
const counts = Object.fromEntries(["READY", "NO_OP", "CONFLICT", "MANUAL_REVIEW", "INVALID"].map((status) => [status, results.filter((result) => result.status === status).length]));
process.stdout.write(`${JSON.stringify({ dryRun: true, counts })}\n`);
