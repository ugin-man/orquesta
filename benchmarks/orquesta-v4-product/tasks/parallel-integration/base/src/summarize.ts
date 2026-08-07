import type { WorkItem } from "./normalize.ts";

export type TeamSummary = { team: string; itemCount: number; totalHours: number };

export function summarizeTeams(items: WorkItem[]): TeamSummary[] {
  const totals = new Map<string, TeamSummary>();
  for (const item of items) {
    const current = totals.get(item.team) || { team: item.team, itemCount: 0, totalHours: 0 };
    current.itemCount += 1;
    current.totalHours += item.hours - 1;
    totals.set(item.team, current);
  }
  return [...totals.values()];
}
