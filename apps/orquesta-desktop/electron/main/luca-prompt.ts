import type { AskLucaInput } from '../../src/contracts/luca';
import { questionDefinition } from './luca-question-catalog';

const MAX_CUSTOM_QUESTION_CHARACTERS = 2_000;

export function buildLucaRequestPrompt(input: AskLucaInput, context: Record<string, unknown>): string {
  const definition = questionDefinition(input.questionId);
  if (definition.contextKind !== input.context.kind) throw new Error('Luca question does not match context kind');
  const customText = input.customText?.trim() ?? '';
  if (definition.custom && !customText) throw new Error('A custom question is required');
  if (definition.custom && customText.length > MAX_CUSTOM_QUESTION_CHARACTERS) {
    throw new Error('A custom question must not exceed 2,000 characters');
  }
  if (!definition.custom && customText) throw new Error('Custom text is not allowed for a non-custom Luca question');

  return JSON.stringify({
    protocol: 'orquesta.luca.ask.v1',
    request: {
      questionId: input.questionId,
      displayQuestion: definition.custom ? customText : definition.label[input.locale],
      intent: definition.intent,
      locale: input.locale,
      answerContract: {
        maxPoints: definition.maxPoints,
        uncertaintyRequiredWhenEvidenceMissing: true,
        shape: {
          answer: 'string',
          points: 'string[]',
          uncertainties: 'string[]',
          references: [{ kind: 'project|phase|task|failure|inspection|agent|attention', id: 'string', label: 'string' }]
        }
      }
    },
    context
  });
}
