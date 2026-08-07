import { normalizeItem, type RawWorkItem } from "./normalize.ts";
import { renderReport } from "./render.ts";
import { summarizeTeams } from "./summarize.ts";

export function buildReport(rawItems: RawWorkItem[]): string {
  const items = rawItems.map(normalizeItem);
  return renderReport(items, summarizeTeams(items));
}
