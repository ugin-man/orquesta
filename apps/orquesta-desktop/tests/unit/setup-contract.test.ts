import { describe, expect, test } from 'vitest';
import {
  SETUP_PHASE_IDS,
  isSetupDraft,
  parseSetupDraft,
  type SetupDraft
} from '../../src/contracts/setup';

const existingFolderDraft = {
  revision: 1,
  status: 'draft',
  source: { kind: 'existing_folder', rootPath: 'C:\\work\\demo' },
  projectName: 'Demo',
  description: '',
  questions: [],
  answers: []
};

describe('setup contract', () => {
  test('keeps the approved six canonical phases in order', () => {
    expect(SETUP_PHASE_IDS).toEqual([
      'environment',
      'understanding',
      'foundation',
      'planning',
      'specialists',
      'operation'
    ]);
  });

  test('parses a bounded existing-folder draft without requiring a description or answers', () => {
    expect(parseSetupDraft(existingFolderDraft)).toEqual(existingFolderDraft);
    expect(isSetupDraft(existingFolderDraft)).toBe(true);
  });

  test('accepts every approved source route', () => {
    const sources: SetupDraft['source'][] = [
      { kind: 'detected_root', rootPath: 'C:\\work\\detected' },
      { kind: 'existing_folder', rootPath: 'C:\\work\\existing' },
      { kind: 'new_project', parentPath: 'C:\\work', folderName: 'new-project' },
      { kind: 'public_github', repositoryUrl: 'https://github.com/example/project', parentPath: 'C:\\work' }
    ];
    for (const source of sources) {
      expect(isSetupDraft({ ...existingFolderDraft, source })).toBe(true);
    }
  });

  test('rejects unsafe or oversized setup inputs', () => {
    expect(isSetupDraft({ ...existingFolderDraft, projectName: '' })).toBe(false);
    expect(isSetupDraft({ ...existingFolderDraft, projectName: 'x'.repeat(129) })).toBe(false);
    expect(isSetupDraft({ ...existingFolderDraft, description: 'x'.repeat(16_385) })).toBe(false);
    expect(isSetupDraft({ ...existingFolderDraft, source: { kind: 'new_project', parentPath: 'C:\\work', folderName: '..' } })).toBe(false);
    expect(isSetupDraft({ ...existingFolderDraft, source: { kind: 'public_github', repositoryUrl: 'http://github.com/a/b', parentPath: 'C:\\work' } })).toBe(false);
    expect(isSetupDraft({ ...existingFolderDraft, questions: Array.from({ length: 4 }, (_, index) => ({ questionId: `q-${index}`, prompt: 'Question?', required: false })) })).toBe(false);
  });

  test('throws a useful error when parsing an invalid draft', () => {
    expect(() => parseSetupDraft({ ...existingFolderDraft, status: 'started' })).toThrow(/setup draft/i);
  });
});
