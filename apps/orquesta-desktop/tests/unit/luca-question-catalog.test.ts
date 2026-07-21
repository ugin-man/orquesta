import { describe, expect, test } from 'vitest';
import { LUCA_QUESTION_IDS } from '../../src/contracts/luca';
import { questionDefinition, questionsFor } from '../../electron/main/luca-question-catalog';

describe('Luca question catalog', () => {
  test('defines every public question id exactly once', () => {
    expect(new Set(LUCA_QUESTION_IDS).size).toBe(LUCA_QUESTION_IDS.length);
    for (const id of LUCA_QUESTION_IDS) expect(questionDefinition(id).id).toBe(id);
  });

  test('orders custom input first on Home and last in record details', () => {
    expect(questionsFor('home').at(0)?.id).toBe('home.custom');
    expect(questionsFor('task').at(-1)?.id).toBe('task.custom');
    expect(questionsFor('failure').at(-1)?.id).toBe('failure.custom');
    expect(questionsFor('inspection').at(-1)?.id).toBe('inspection.custom');
  });

  test('keeps the approved question counts and context kind binding', () => {
    expect(questionsFor('home')).toHaveLength(18);
    expect(questionsFor('task')).toHaveLength(4);
    expect(questionsFor('failure')).toHaveLength(4);
    expect(questionsFor('inspection')).toHaveLength(4);
    for (const kind of ['home', 'task', 'failure', 'inspection'] as const) {
      expect(questionsFor(kind).every((question) => question.contextKind === kind)).toBe(true);
    }
  });
});
