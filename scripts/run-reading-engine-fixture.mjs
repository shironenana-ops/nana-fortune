let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
const payload = JSON.parse(input);
const { runShironeEngineOnServer } = await import(
  "../dist/reading-engine/index.mjs"
);

process.stdout.write(JSON.stringify(runShironeEngineOnServer(payload)));
