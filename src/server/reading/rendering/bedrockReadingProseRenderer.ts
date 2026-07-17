import { BedrockRuntimeClient, ConverseCommand, type ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import type { DocumentType } from "@smithy/types";
import { buildReadingProsePrompt } from "./readingProsePrompt";
import { buildReadingProseJsonSchema } from "./readingProseSchema";
import type { ReadingProseCanonicalInput, ReadingProseInvalidOutputDetail, ReadingProseProviderResult, ReadingProseRenderer } from "./readingProseRenderer";

type BedrockSender = { send(command: ConverseCommand, options?: { abortSignal?: AbortSignal }): Promise<ConverseCommandOutput> };

export type BedrockReadingRendererConfig = {
  enabled: boolean;
  region: string;
  modelId: string;
  timeoutMs: number;
  modelAlias?: string;
};

export function readBedrockRendererConfig(env: Record<string, string | undefined> = process.env): BedrockReadingRendererConfig {
  const enabled = env.READING_BEDROCK_ENABLED === "true";
  const region = env.AWS_REGION?.trim() ?? "";
  const modelId = env.BEDROCK_MODEL_ID?.trim() ?? "";
  const rawTimeout = env.READING_BEDROCK_TIMEOUT_MS;
  let timeoutMs = 60_000;
  if (rawTimeout !== undefined) {
    if (!/^\d+$/u.test(rawTimeout)) throw new Error("BEDROCK_TIMEOUT_INVALID");
    timeoutMs = Number(rawTimeout);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 180_000) {
      throw new Error("BEDROCK_TIMEOUT_INVALID");
    }
  }
  if (enabled && (!region || !/^[a-z]{2}-[a-z]+-\d$/u.test(region))) throw new Error("BEDROCK_REGION_INVALID");
  if (enabled && (!modelId || modelId.length > 512 || /[\u0000-\u001f\u007f]/u.test(modelId))) throw new Error("BEDROCK_MODEL_ID_INVALID");
  return { enabled, region, modelId, timeoutMs, modelAlias: env.BEDROCK_MODEL_ALIAS?.trim() || undefined };
}

export class BedrockReadingOutputError extends Error {
  constructor(public readonly detail: ReadingProseInvalidOutputDetail) {
    super("BEDROCK_OUTPUT_INVALID");
    this.name = "BedrockReadingOutputError";
  }
}

function responseToolInput(output: ConverseCommandOutput): unknown {
  if (output.stopReason !== "tool_use") throw new BedrockReadingOutputError("stop_reason");
  const blocks = output.output?.message?.content;
  if (!Array.isArray(blocks) || blocks.length === 0) throw new BedrockReadingOutputError("tool_missing");
  const toolBlocks = blocks.filter((block) => "toolUse" in block && block.toolUse !== undefined);
  if (toolBlocks.length === 0) throw new BedrockReadingOutputError("tool_missing");
  if (toolBlocks.length !== 1) throw new BedrockReadingOutputError("tool_count");
  if (blocks.length !== 1 || Object.keys(toolBlocks[0]).some((key) => key !== "toolUse")) {
    throw new BedrockReadingOutputError("unknown");
  }
  const toolUse = toolBlocks[0].toolUse;
  if (!toolUse || toolUse.name !== "shirone_render") throw new BedrockReadingOutputError("tool_name");
  if (!("input" in toolUse) || toolUse.input === undefined) throw new BedrockReadingOutputError("tool_input");
  return toolUse.input;
}

export class BedrockReadingProseRenderer implements ReadingProseRenderer {
  private readonly sender: BedrockSender;
  constructor(private readonly config: BedrockReadingRendererConfig, sender?: BedrockSender) {
    if (!config.enabled) throw new Error("BEDROCK_DISABLED");
    this.sender = sender ?? new BedrockRuntimeClient({ region: config.region, maxAttempts: 1 });
  }
  async render(input: ReadingProseCanonicalInput, options?: { signal?: AbortSignal }): Promise<ReadingProseProviderResult> {
    const prompt = buildReadingProsePrompt(input);
    const schema = JSON.parse(buildReadingProseJsonSchema(input)) as DocumentType;
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    const signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let output: ConverseCommandOutput;
    try {
      output = await this.sender.send(new ConverseCommand({
        modelId: this.config.modelId,
        system: [{ text: prompt.system }],
        messages: [{ role: "user", content: [{ text: prompt.user }] }],
        inferenceConfig: { temperature: 0.2, maxTokens: input.mode === "light" ? 5_000 : 12_000 },
        toolConfig: {
          tools: [{
            toolSpec: {
              name: "shirone_render",
              description: "白音七の鑑定内容を、意味を変えず読みやすい日本語へ整形する",
              inputSchema: { json: schema },
            },
          }],
          toolChoice: { tool: { name: "shirone_render" } },
        },
      }), { abortSignal: signal });
    } catch (error) {
      if (timeout.aborted) throw new DOMException("BEDROCK_TIMEOUT", "TimeoutError");
      throw error;
    }
    return {
      output: responseToolInput(output), provider: "bedrock", modelAlias: this.config.modelAlias,
      inputTokens: output.usage?.inputTokens, outputTokens: output.usage?.outputTokens,
    };
  }
}
