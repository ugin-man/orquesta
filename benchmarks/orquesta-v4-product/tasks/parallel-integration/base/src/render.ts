import type { TeamSummary } from "./summarize.ts";
import type { WorkItem } from "./normalize.ts";

export function renderReport(items: WorkItem[], teams: TeamSummary[]): string {
  return JSON.stringify({ items, teams }, null, 2);
}
