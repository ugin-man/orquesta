export type RawWorkItem = { id: string; title: string; team: string; hours: string | number };
export type WorkItem = { id: string; title: string; team: string; hours: number };

export function normalizeItem(raw: RawWorkItem): WorkItem {
  return {
    id: raw.id.trim().toLowerCase(),
    title: raw.title,
    team: raw.team.trim().toLowerCase(),
    hours: Number(raw.hours)
  };
}
