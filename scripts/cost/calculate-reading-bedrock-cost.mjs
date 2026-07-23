import { pathToFileURL } from "node:url";

const MILLION = 1_000_000;

function finiteNonNegative(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name}_INVALID`);
  }
  return value;
}

export function calculateReadingBedrockCost({
  inputTokens,
  outputTokens,
  inputUsdPerMillion,
  outputUsdPerMillion,
  fxRates,
}) {
  const input = finiteNonNegative(inputTokens, "INPUT_TOKENS");
  const output = finiteNonNegative(outputTokens, "OUTPUT_TOKENS");
  const inputPrice = finiteNonNegative(inputUsdPerMillion, "INPUT_PRICE");
  const outputPrice = finiteNonNegative(outputUsdPerMillion, "OUTPUT_PRICE");
  if (!Array.isArray(fxRates) || fxRates.length === 0) throw new TypeError("FX_RATES_INVALID");

  const inputUsd = (input / MILLION) * inputPrice;
  const outputUsd = (output / MILLION) * outputPrice;
  const totalUsd = inputUsd + outputUsd;
  const jpyByFx = Object.fromEntries(fxRates.map((rate) => {
    const safeRate = finiteNonNegative(rate, "FX_RATE");
    if (safeRate === 0) throw new TypeError("FX_RATE_INVALID");
    return [String(safeRate), totalUsd * safeRate];
  }));

  return { inputUsd, outputUsd, totalUsd, jpyByFx };
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new TypeError("ARGUMENT_INVALID");
    values[key.slice(2)] = value;
  }
  const number = (key) => Number(values[key]);
  return {
    inputTokens: number("input-tokens"),
    outputTokens: number("output-tokens"),
    inputUsdPerMillion: number("input-price"),
    outputUsdPerMillion: number("output-price"),
    fxRates: (values.fx ?? "140,160,180").split(",").map(Number),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = calculateReadingBedrockCost(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
