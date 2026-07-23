import test from "node:test";
import assert from "node:assert/strict";
import { calculateReadingBedrockCost } from "../scripts/cost/calculate-reading-bedrock-cost.mjs";

test("input/outputを分離し複数為替で原価を計算する", () => {
  const result = calculateReadingBedrockCost({
    inputTokens: 6_000,
    outputTokens: 3_000,
    inputUsdPerMillion: 1.1,
    outputUsdPerMillion: 5.5,
    fxRates: [140, 160, 180],
  });
  assert.ok(Math.abs(result.inputUsd - 0.0066) < 1e-12);
  assert.ok(Math.abs(result.outputUsd - 0.0165) < 1e-12);
  assert.ok(Math.abs(result.totalUsd - 0.0231) < 1e-12);
  assert.ok(Math.abs(result.jpyByFx["160"] - 3.696) < 1e-12);
});

test("0 tokenを許容し、不正・負数・空の為替を拒否する", () => {
  assert.equal(calculateReadingBedrockCost({ inputTokens: 0, outputTokens: 0, inputUsdPerMillion: 1, outputUsdPerMillion: 1, fxRates: [160] }).totalUsd, 0);
  for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => calculateReadingBedrockCost({ inputTokens: value, outputTokens: 0, inputUsdPerMillion: 1, outputUsdPerMillion: 1, fxRates: [160] }));
  }
  assert.throws(() => calculateReadingBedrockCost({ inputTokens: 1, outputTokens: 1, inputUsdPerMillion: 1, outputUsdPerMillion: 1, fxRates: [] }));
});
