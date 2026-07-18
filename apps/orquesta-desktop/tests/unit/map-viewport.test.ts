import { describe, expect, test } from 'vitest';
import { compactAgentName, fitCamera, semanticLevelForZoom, worldToScreen } from '../../src/renderer/features/map/MapViewport';

describe('Map viewport projection', () => {
  test('uses three deterministic semantic zoom levels', () => {
    expect(semanticLevelForZoom(0.3)).toBe('overview');
    expect(semanticLevelForZoom(0.6)).toBe('normal');
    expect(semanticLevelForZoom(1)).toBe('detail');
  });

  test('projects world coordinates without scaling node contents', () => {
    expect(worldToScreen({ x: 100, y: 80 }, { x: 20, y: -10, zoom: 0.5 })).toEqual({ x: 70, y: 30 });
  });

  test('fits the world inside the desktop instrument gutters', () => {
    const camera = fitCamera({ width: 1440, height: 900 }, { width: 1200, height: 900 });
    expect(camera.x).toBeGreaterThanOrEqual(290);
    expect(camera.y).toBeGreaterThanOrEqual(80);
    expect(camera.x + 1200 * camera.zoom).toBeLessThanOrEqual(1150);
    expect(camera.y + 900 * camera.zoom).toBeLessThanOrEqual(770);
  });

  test('keeps a distinguishing suffix in overview labels', () => {
    expect(compactAgentName('Connector 02')).toBe('CONNE 02');
    expect(compactAgentName('Orchestrator')).toBe('ORCHESTR');
  });
});
