import type { InspectionKind, InspectionTargetUi } from '../../src/contracts/orquesta-ui';

export interface InspectionOutputEnvelope {
  outcome: 'report_ready' | 'partial';
  sourceCount: number;
  markdown: string;
}

export interface InspectionPromptInput {
  runId: string;
  projectId: string;
  kind: InspectionKind;
  target: Pick<InspectionTargetUi, 'kind' | 'ids'>;
  focus: string | null;
}

const OUTPUT_CONTRACT = `Return exactly one JSON object and no code fence or surrounding prose:
{"outcome":"report_ready"|"partial","sourceCount":0,"markdown":"complete Markdown report"}`;

export function buildInspectionPrompt(input: InspectionPromptInput): string {
  const scope = `${input.target.kind}:${input.target.ids.join(',') || 'project-root'}`;
  const common = `You are a temporary read-only Orquesta inspection agent.
Run ID: ${input.runId}
Project ID: ${input.projectId}
Scope: ${scope}
Read the selected project repository and its current .orquesta evidence. Do not edit files, run mutating commands, message agents, change tasks, or change the organization. Clearly separate observed evidence from hypotheses.`;

  if (input.kind === 'external_benchmark') {
    return `${common}
Use live Web search. Compare this project with current similar OSS projects, products, research, or Web services. Do not substitute memory when external sources cannot be reached.
Optional focus: ${input.focus ?? 'none'}
The Markdown report must include project evidence, compared products, an HTTP(S) URL and ISO access date for every counted source, selection reason, common comparison axes, current strengths, gaps, differentiation, reusable assets, unknowns, and proposals. Set sourceCount to the number of distinct cited URLs. Use partial only when some required evidence is unavailable but at least one valid source was inspected.
${OUTPUT_CONTRACT}`;
  }

  return `${common}
Web search is disabled. Audit only repository evidence for excessive review, duplicated roles, oversized tasks, avoidable round trips, unclear ownership, failures, waiting, delegation, verification, and context boundaries.
The Markdown report must include audit scope and evidence read. Every formal finding must include an evidence reference, severity, current impact, recommendation, change cost, and no-change risk. Put unsupported concerns only under a Hypotheses heading. Do not attack people or agent names.
${OUTPUT_CONTRACT}`;
}
