import { BedrockRuntimeClient, ConverseCommand, type ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import type { DocumentType } from "@smithy/types";
import { buildReadingProsePrompt } from "./readingProsePrompt";
import { buildReadingProseJsonSchema } from "./readingProseSchema";
import type { ReadingProseCanonicalInput, ReadingProseInvalidOutputDetail, ReadingProseProviderResult, ReadingProseRenderer } from "./readingProseRenderer";

type BedrockSender = { send(command: ConverseCommand, options?: { abortSignal?: AbortSignal }): Promise<ConverseCommandOutput> };

export type BedrockReadingRendererConfig = {
  enabled: boolean;
  region: string;
  timeoutMs: number;
  models: {
    light: { modelId: string; modelAlias?: string };
    deep: { modelId: string; modelAlias?: string };
  };
};

const MODEL_ID_MAX_LENGTH = 512;
const MODEL_ALIAS_MAX_LENGTH = 128;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

function readModelConfig(env: Record<string, string | undefined>, mode: "light" | "deep") {
  const prefix = mode === "light" ? "BEDROCK_LIGHT" : "BEDROCK_DEEP";
  return {
    modelId: env[`${prefix}_MODEL_ID`]?.trim() ?? "",
    modelAlias: env[`${prefix}_MODEL_ALIAS`]?.trim() || undefined,
  };
}

function validateModelConfig(model: { modelId: string; modelAlias?: string }, mode: "light" | "deep") {
  if (!model.modelId || model.modelId.length > MODEL_ID_MAX_LENGTH || CONTROL_CHARACTERS.test(model.modelId)) {
    throw new Error(`BEDROCK_${mode.toUpperCase()}_MODEL_ID_INVALID`);
  }
  if (model.modelAlias && (model.modelAlias.length > MODEL_ALIAS_MAX_LENGTH || CONTROL_CHARACTERS.test(model.modelAlias))) {
    throw new Error(`BEDROCK_${mode.toUpperCase()}_MODEL_ALIAS_INVALID`);
  }
}

export function readBedrockRendererConfig(env: Record<string, string | undefined> = process.env): BedrockReadingRendererConfig {
  const enabled = env.READING_BEDROCK_ENABLED === "true";
  const region = env.AWS_REGION?.trim() ?? "";
  const models = {
    light: readModelConfig(env, "light"),
    deep: readModelConfig(env, "deep"),
  };
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
  if (enabled) {
    validateModelConfig(models.light, "light");
    validateModelConfig(models.deep, "deep");
  }
  return { enabled, region, timeoutMs, models };
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
    const selectedModel = input.mode === "light"
      ? this.config.models.light
      : input.mode === "deep"
        ? this.config.models.deep
        : undefined;
    if (!selectedModel) throw new Error("BEDROCK_MODE_INVALID");
    const prompt = buildReadingProsePrompt(input);
    const schema = JSON.parse(buildReadingProseJsonSchema(input)) as DocumentType;
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    const signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let output: ConverseCommandOutput;
    try {
      output = await this.sender.send(new ConverseCommand({
        modelId: selectedModel.modelId,
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
      output: responseToolInput(output), provider: "bedrock", modelAlias: selectedModel.modelAlias,
      inputTokens: output.usage?.inputTokens, outputTokens: output.usage?.outputTokens,
    };
  }
}
