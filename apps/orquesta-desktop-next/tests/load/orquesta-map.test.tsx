import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { buildOrquestaMapLayout, OrquestaMap } from '../../src/components/OrquestaMap';
import { stressAgent, stressSnapshot } from '../support/orquesta-map-fixtures';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('Orquesta organization map explicit load boundary', () => {
  test('keeps eight hundred lines and sixteen hundred agents finite and distinct', () => {
    const snapshot = stressSnapshot(Array.from({ length: 800 }, (_, index) => stressAgent(
      `line-${String(index).padStart(3, '0')}-lead`,
      'orchestrator',
      `line-${String(index).padStart(3, '0')}`,
    )));
    const layout = buildOrquestaMapLayout(snapshot, 'radial');
    const workers = layout.nodes.filter((node) => node.agent.parentAgentId === 'orchestrator');

    expect(workers).toHaveLength(800);
    expect(layout.lines).toHaveLength(800);
    expect(new Set(workers.map((node) => `${node.x.toFixed(6)}:${node.y.toFixed(6)}`)).size).toBe(800);
    expect(workers.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
    expect(layout.bounds.width).toBeGreaterThan(40_000);
    expect(layout.bounds.width).toBeLessThan(100_000);

    const treeLayout = buildOrquestaMapLayout(snapshot, 'tree');
    const treeOrchestrator = treeLayout.nodes.find((node) => node.agent.id === 'orchestrator')!;
    const treeWorkers = treeLayout.nodes.filter((node) => node.agent.parentAgentId === 'orchestrator');
    const treeRays = new Set(treeWorkers.map((node) => Math.atan2(node.x - treeOrchestrator.x, node.y - treeOrchestrator.y).toFixed(8)));
    expect(treeRays.size).toBe(800);
    expect(treeLayout.bounds.width).toBeLessThan(10_000);
    expect(treeLayout.bounds.height).toBeLessThan(10_000);

    const branchedAgents = Array.from({ length: 800 }, (_, index) => {
      const lineId = `branched-line-${String(index).padStart(3, '0')}`;
      const leadId = `${lineId}-lead`;
      return [stressAgent(leadId, 'orchestrator', lineId), stressAgent(`${lineId}-worker`, leadId, lineId)];
    }).flat();
    const branchedSnapshot = stressSnapshot(branchedAgents);
    const branchedTree = buildOrquestaMapLayout(branchedSnapshot, 'tree');
    const branchedOrchestrator = branchedTree.nodes.find((node) => node.agent.id === 'orchestrator')!;
    const branchedLeads = branchedTree.nodes.filter((node) => node.agent.parentAgentId === 'orchestrator');
    expect(new Set(branchedTree.nodes.filter((node) => !['orquesta-admin', 'user-support'].includes(node.agent.id)).map((node) => `${node.x.toFixed(6)}:${node.y.toFixed(6)}`)).size).toBe(1_601);
    expect(new Set(branchedLeads.map((node) => Math.atan2(node.x - branchedOrchestrator.x, node.y - branchedOrchestrator.y).toFixed(8))).size).toBe(800);
    expect(branchedTree.bounds.width).toBeLessThan(20_000);
    expect(branchedTree.bounds.height).toBeLessThan(20_000);
    const branchedRadial = buildOrquestaMapLayout(branchedSnapshot, 'radial');
    expect(branchedRadial.lines).toHaveLength(800);
    expect(branchedRadial.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
  });

  test('renders eight hundred lines as a label-suppressed overview and culls a focused viewport', () => {
    const snapshot = stressSnapshot(Array.from({ length: 800 }, (_, index) => stressAgent(`dense-${index}`, 'orchestrator', `dense-line-${index}`)));
    const { container } = render(<OrquestaMap snapshot={snapshot} selectedAgentId={null} onSelectAgent={() => undefined} locale="en" />);

    expect(container.querySelector('.map-network-stage')).toHaveClass('has-dense-lines');
    expect(container.querySelector('.map-network-stage')).toHaveClass('is-micro-overview');
    expect(container.querySelectorAll('.map-line-region')).toHaveLength(800);
    expect(container.querySelectorAll('[data-agent-id]')).toHaveLength(803);

    fireEvent.click(screen.getByRole('button', { name: 'Tree layout' }));
    expect(container.querySelector('.map-network-stage')).toHaveClass('has-dense-lines');
    expect(container.querySelector('.map-network-foot')).toHaveTextContent('TREE / 800 LINES / MICRO');
    expect(container.querySelector('.map-network-stage')).toHaveAttribute('data-rendered-edge-count', '3');

    fireEvent.change(screen.getByRole('textbox', { name: 'Find agent' }), { target: { value: 'Orchestrator' } });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Find agent' }), { key: 'Enter' });

    const stage = container.querySelector('.map-network-stage')!;
    expect(stage).not.toHaveClass('is-micro-overview');
    expect(Number(stage.getAttribute('data-rendered-agent-count'))).toBeLessThan(20);
    expect(Number(stage.getAttribute('data-rendered-edge-count'))).toBeLessThan(20);
    expect(container.querySelectorAll('[data-agent-id]').length).toBeLessThan(20);

    fireEvent.click(screen.getByRole('button', { name: 'Fit all' }));
    expect(stage).toHaveClass('is-micro-overview');
    expect(container.querySelectorAll('[data-agent-id]')).toHaveLength(803);
  }, 15_000);
});
