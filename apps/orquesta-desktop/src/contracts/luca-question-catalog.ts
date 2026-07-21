import type { LucaContextKind, LucaQuestionId } from './luca';

export interface LucaQuestionDefinition {
  id: LucaQuestionId;
  contextKind: LucaContextKind;
  label: { ja: string; en: string };
  intent: string;
  maxPoints: number;
  custom: boolean;
}

const definitions: LucaQuestionDefinition[] = [
  { id: 'task.explain', contextKind: 'task', label: { ja: 'このタスクを簡単に説明して', en: 'Explain this task simply' }, intent: 'Explain the work and why it exists as one concise explanation. Do not merely restate status.', maxPoints: 3, custom: false },
  { id: 'task.outcome', contextKind: 'task', label: { ja: '完了すると何が変わる？', en: 'What changes when it is complete?' }, intent: 'Explain the recorded artifact and concrete expected change. Do not invent release impact.', maxPoints: 3, custom: false },
  { id: 'task.important', contextKind: 'task', label: { ja: '重要な点や注意点は？', en: 'What matters or needs care?' }, intent: 'Select at most three acceptance, dependency, blocker, or uncertainty points that matter to the user.', maxPoints: 3, custom: false },
  { id: 'task.custom', contextKind: 'task', label: { ja: '自由に聞く', en: 'Ask freely' }, intent: 'Answer only the custom question using the selected task context.', maxPoints: 3, custom: true },
  { id: 'failure.explain', contextKind: 'failure', label: { ja: 'このエラーを簡単に説明して', en: 'Explain this error simply' }, intent: 'Explain what happened without unnecessary technical jargon.', maxPoints: 3, custom: false },
  { id: 'failure.cause-impact', contextKind: 'failure', label: { ja: '原因と影響を教えて', en: 'Explain the cause and impact' }, intent: 'Separate confirmed cause from suspected cause and explain recorded or inferable impact.', maxPoints: 3, custom: false },
  { id: 'failure.recovery', contextKind: 'failure', label: { ja: '解決には何が必要？', en: 'What is needed to resolve it?' }, intent: 'Explain recorded fixes, attempts, and prevention without performing any repair.', maxPoints: 3, custom: false },
  { id: 'failure.custom', contextKind: 'failure', label: { ja: '自由に聞く', en: 'Ask freely' }, intent: 'Answer only the custom question using the selected failure context.', maxPoints: 3, custom: true },
  { id: 'inspection.explain', contextKind: 'inspection', label: { ja: 'この結果を簡単に説明して', en: 'Explain this result simply' }, intent: 'Summarize target, focus, and conclusion from the saved report.', maxPoints: 3, custom: false },
  { id: 'inspection.key-finding', contextKind: 'inspection', label: { ja: '一番重要な指摘は？', en: 'What is the most important finding?' }, intent: 'Choose one most consequential finding and explain why, with report evidence.', maxPoints: 3, custom: false },
  { id: 'inspection.evidence', contextKind: 'inspection', label: { ja: '根拠と限界を教えて', en: 'Explain the evidence and limits' }, intent: 'Separate evidence, missing information, truncation, and inference limits.', maxPoints: 3, custom: false },
  { id: 'inspection.custom', contextKind: 'inspection', label: { ja: '自由に聞く', en: 'Ask freely' }, intent: 'Answer only the custom question using the selected inspection context.', maxPoints: 3, custom: true },
  { id: 'home.custom', contextKind: 'home', label: { ja: '自由に聞く', en: 'Ask freely' }, intent: 'Answer only the custom question using the bounded project overview.', maxPoints: 8, custom: true },
  { id: 'home.current', contextKind: 'home', label: { ja: '今、何をしている？', en: 'What is happening now?' }, intent: 'Give a short current-state summary from active work, attention, and recent events.', maxPoints: 8, custom: false },
  { id: 'home.active', contextKind: 'home', label: { ja: '重要な進行中タスクは？', en: 'Which active tasks matter most?' }, intent: 'Select the most consequential active tasks and explain why they matter.', maxPoints: 8, custom: false },
  { id: 'home.blocked', contextKind: 'home', label: { ja: '何か止まっている？', en: 'Is anything blocked?' }, intent: 'List recorded blocked or stalled work and distinguish confirmed blockers from risk.', maxPoints: 8, custom: false },
  { id: 'home.completed', contextKind: 'home', label: { ja: '最近、何が終わった？', en: 'What finished recently?' }, intent: 'Summarize recently completed work and recorded artifacts without inventing impact.', maxPoints: 8, custom: false },
  { id: 'home.next', contextKind: 'home', label: { ja: '次に何をする予定？', en: 'What is planned next?' }, intent: 'Explain explicit pending or next work only; do not create a new plan.', maxPoints: 8, custom: false },
  { id: 'home.user-review', contextKind: 'home', label: { ja: '私が確認することは？', en: 'What do I need to review?' }, intent: 'List open items that explicitly require user review.', maxPoints: 8, custom: false },
  { id: 'home.user-answer', contextKind: 'home', label: { ja: '私の回答待ちはある？', en: 'Is anything waiting for my answer?' }, intent: 'List open questions or requests explicitly waiting for the user.', maxPoints: 8, custom: false },
  { id: 'home.user-decision', contextKind: 'home', label: { ja: '今、決める必要があることは？', en: 'What decisions are needed now?' }, intent: 'List unresolved user decisions and their recorded consequences.', maxPoints: 8, custom: false },
  { id: 'home.overlooked', contextKind: 'home', label: { ja: '見落としている重要事項はある？', en: 'Am I overlooking anything important?' }, intent: 'Identify high-priority attention, blockers, failures, or dependencies not already obvious from the current summary.', maxPoints: 8, custom: false },
  { id: 'home.project', contextKind: 'home', label: { ja: 'このプロジェクトを簡単に説明して', en: 'Explain this project simply' }, intent: 'Explain the project goal, present scope, and current state from recorded project data.', maxPoints: 8, custom: false },
  { id: 'home.phase', contextKind: 'home', label: { ja: '今は全体のどの段階？', en: 'What phase is the project in?' }, intent: 'Explain the recorded phase or infer the stage only when evidence supports it, labeling inference.', maxPoints: 8, custom: false },
  { id: 'home.changed', contextKind: 'home', label: { ja: '前回から何が変わった？', en: 'What changed since last time?' }, intent: 'Compare records newer than the saved Luca Home baseline; state when no baseline exists.', maxPoints: 8, custom: false },
  { id: 'home.organization', contextKind: 'home', label: { ja: '現在の組織を説明して', en: 'Explain the current organization' }, intent: 'Explain active agents, teams, lines, and reporting relationships from the organization snapshot.', maxPoints: 8, custom: false },
  { id: 'home.health', contextKind: 'home', label: { ja: '目標に対して順調？', en: 'Is the project on track?' }, intent: 'Assess progress only from recorded goals, completions, blockers, failures, and attention; expose missing evidence.', maxPoints: 8, custom: false },
  { id: 'home.recent-errors', contextKind: 'home', label: { ja: '最近の重要なエラーは？', en: 'What important errors happened recently?' }, intent: 'Select recent consequential failures, current resolution state, and impact.', maxPoints: 8, custom: false },
  { id: 'home.repeated', contextKind: 'home', label: { ja: '同じ問題が繰り返されている？', en: 'Are any problems repeating?' }, intent: 'Identify repeated failure signatures or recurring blocked patterns using recorded occurrences only.', maxPoints: 8, custom: false },
  { id: 'home.bottleneck', contextKind: 'home', label: { ja: '作業が詰まりやすい場所は？', en: 'Where are the bottlenecks?' }, intent: 'Identify concentrations of blocked work, dependencies, repeated failures, or overloaded ownership from the bounded snapshot.', maxPoints: 8, custom: false }
];

const byId = new Map(definitions.map((definition) => [definition.id, definition]));

export function questionDefinition(id: LucaQuestionId): LucaQuestionDefinition {
  const definition = byId.get(id);
  if (!definition) throw new Error(`Unknown Luca question: ${id}`);
  return definition;
}

export function questionsFor(kind: LucaContextKind): LucaQuestionDefinition[] {
  return definitions.filter((definition) => definition.contextKind === kind);
}
