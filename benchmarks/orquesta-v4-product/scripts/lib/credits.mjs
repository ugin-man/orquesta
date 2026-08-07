function round(value, places = 6) {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function calculateCredits(tokenEvidence, rateSnapshot) {
  if (tokenEvidence?.coverage !== "complete") {
    return { status: "unknown", consumed: null, by_model: [], missing_models: [], reason: "token coverage is not complete" };
  }
  const rates = new Map((rateSnapshot?.models || []).map((rate) => [rate.model, rate]));
  const missingModels = Object.keys(tokenEvidence.by_model || {}).filter((model) => !rates.has(model));
  if (missingModels.length > 0) {
    return { status: "unknown", consumed: null, by_model: [], missing_models: missingModels.sort(), reason: "one or more model rates are missing" };
  }

  const byModel = [];
  let consumed = 0;
  for (const [model, usage] of Object.entries(tokenEvidence.by_model || {})) {
    const rate = rates.get(model);
    if (usage.cached_input_tokens > usage.input_tokens) {
      return { status: "unknown", consumed: null, by_model: [], missing_models: [], reason: `cached input exceeds input for ${model}` };
    }
    const uncached = usage.input_tokens - usage.cached_input_tokens;
    const modelCredits = (
      uncached * rate.input_per_million
      + usage.cached_input_tokens * rate.cached_input_per_million
      + usage.output_tokens * rate.output_per_million
    ) / 1_000_000;
    consumed += modelCredits;
    byModel.push({ model, uncached_input_tokens: uncached, cached_input_tokens: usage.cached_input_tokens, output_tokens: usage.output_tokens, reasoning_output_tokens: usage.reasoning_output_tokens, consumed: round(modelCredits) });
  }
  return { status: "complete", consumed: round(consumed), by_model: byModel.sort((a, b) => a.model.localeCompare(b.model)), missing_models: [], reason: null };
}
