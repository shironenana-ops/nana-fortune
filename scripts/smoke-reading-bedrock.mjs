const enabled = process.env.READING_BEDROCK_SMOKE === "true";
if (!enabled) {
  console.error("READING_BEDROCK_SMOKE=true を明示した場合だけ実行できます。");
  process.exitCode = 2;
} else {
  const foundation = await import("../dist/reading-server-foundation/index.mjs");
  const engine = await import("../dist/reading-engine/index.mjs");
  const started = Date.now();
  try {
    const config = foundation.readBedrockRendererConfig(process.env);
    if (!config.enabled) throw new Error("BEDROCK_CONFIGURATION_INVALID");
    const reading = engine.runShironeEngineOnServer({ name: "架空 花子", birthDate: "1984-12-29", question: "これからの流れを知りたい", today: "2026-07-17", plan: "light" });
    const result = await foundation.renderReadingWithFallback({ renderer: new foundation.BedrockReadingProseRenderer(config), enabled: true, requestId: crypto.randomUUID(), displayName: "架空 花子", question: "これからの流れを知りたい", reading, auditSink: () => {} });
    console.log(JSON.stringify({ status: result.rendering.status, duration_ms: Date.now() - started, section_count: result.sections.length, character_count: result.sections.reduce((n, s) => n + s.body.length, 0), ...(result.rendering.fallbackReason ? { fallback_reason: result.rendering.fallbackReason } : {}), ...(result.rendering.invalidOutputDetail ? { invalid_output_detail: result.rendering.invalidOutputDetail } : {}) }));
    if (result.rendering.status !== "rendered") process.exitCode = 1;
  } catch {
    console.log(JSON.stringify({ status: "fallback", duration_ms: Date.now() - started, fallback_reason: "configuration_error" }));
    process.exitCode = 1;
  }
}
