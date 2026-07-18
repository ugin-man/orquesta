import { activeProjectFixture } from './active-project';
import { allIdleFixture } from './all-idle';
import { attentionHeavyFixture } from './attention-heavy';
import { largeRosterFixture } from './large-roster';
import { longJapaneseTextFixture } from './long-japanese-text';
import { nestedRosterFixture } from './nested-roster';
import { offlineProjectFixture } from './offline-project';
import { unknownEvidenceFixture } from './unknown-evidence';
import { wideRosterFixture } from './wide-roster';
import type { FixtureDefinition } from './types';

export const fixtureCatalog = {
  'active-project': activeProjectFixture,
  'all-idle': allIdleFixture,
  'attention-heavy': attentionHeavyFixture,
  'large-roster': largeRosterFixture,
  'nested-roster': nestedRosterFixture,
  'wide-roster': wideRosterFixture,
  'offline-project': offlineProjectFixture,
  'unknown-evidence': unknownEvidenceFixture,
  'long-japanese-text': longJapaneseTextFixture
} satisfies Record<string, FixtureDefinition>;

export type FixtureId = keyof typeof fixtureCatalog;
export const fixtureKeys = Object.keys(fixtureCatalog) as FixtureId[];
export type RendererFixture = FixtureDefinition;

export function fixtureIdForProject(projectId: string): FixtureId | null {
  return fixtureKeys.find((key) => fixtureCatalog[key].snapshot.project.id === projectId) ?? null;
}
