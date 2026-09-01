import { previewSnapshot } from '../../src/testing/preview-client';

export function stressAgent(id: string, parentAgentId: string | null, lineId: string | null, displayName = id) {
  return {
    ...previewSnapshot.agents.find((agent) => agent.id === 'frontend')!,
    id,
    displayName,
    parentAgentId,
    lineId,
    teamId: 'stress',
    currentTaskId: null,
    currentTaskTitle: null,
    status: 'standby' as const,
  };
}

export function stressSnapshot(organizationAgents: ReturnType<typeof stressAgent>[]) {
  const orchestrator = {
    ...previewSnapshot.agents.find((agent) => agent.id === 'orchestrator')!,
    currentTaskId: null,
    currentTaskTitle: null,
    lineId: null,
  };
  const services = previewSnapshot.agents.filter((agent) => ['orquesta-admin', 'user-support'].includes(agent.id));
  const agents = [orchestrator, ...services, ...organizationAgents];
  return {
    ...previewSnapshot,
    project: { ...previewSnapshot.project, agentCount: agents.length, provenWorkingAgentCount: 0 },
    agents,
    tasks: [],
  };
}
