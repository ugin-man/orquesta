import type { AgentProposal, ConversationMessage } from '../contracts/bridge';
import type { AttentionUiItem, OrquestaUiSnapshot } from '../contracts/orquesta-ui';

export interface FixtureDefinition {
  snapshot: OrquestaUiSnapshot;
  conversations: Record<string, ConversationMessage[]>;
  attentionHistory: AttentionUiItem[];
  agentProposals: AgentProposal[];
  lastOpenedAt: string;
}
