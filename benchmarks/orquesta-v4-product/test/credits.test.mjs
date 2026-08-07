import assert from "node:assert/strict";
import test from "node:test";

import { calculateCredits } from "../scripts/lib/credits.mjs";

const rates = {
  retrieved_at: "2026-07-22",
  source_url: "https://help.openai.com/en/articles/20001106-codex-rate-card",
  models: [
    { model: "gpt-5.6-sol", input_per_million: 125, cached_input_per_million: 12.5, output_per_million: 750 }
  ]
};

test("prices uncached input, cached input, and output without double counting reasoning", () => {
  const result = calculateCredits({
    coverage: "complete",
    by_model: {
      "gpt-5.6-sol": { input_tokens: 1_000_000, cached_input_tokens: 400_000, output_tokens: 100_000, reasoning_output_tokens: 60_000, total_tokens: 1_100_000 }
    }
  }, rates);
  assert.equal(result.status, "complete");
  assert.equal(result.consumed, 155);
  assert.equal(result.by_model[0].uncached_input_tokens, 600_000);
});

test("does not invent a credit estimate for missing model rates or partial usage", () => {
  const unknownModel = calculateCredits({ coverage: "complete", by_model: { "unknown-model": { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 } } }, rates);
  assert.equal(unknownModel.status, "unknown");
  assert.deepEqual(unknownModel.missing_models, ["unknown-model"]);

  const partial = calculateCredits({ coverage: "partial", by_model: {} }, rates);
  assert.equal(partial.status, "unknown");
  assert.match(partial.reason, /coverage/i);
});
