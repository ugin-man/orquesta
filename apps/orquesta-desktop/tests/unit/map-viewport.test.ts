import { describe, expect, test } from 'vitest';
import { compactAgentName, fitCamera, semanticLevelForZoom, worldToScreen } from '../../src/renderer/features/map/MapViewport';

describe('Map viewport projection', () => {
  test('uses three deterministic semantic zoom levels', () => {
    expect(semanticLevelForZoom(0.2)).toBe('overview');
    expect(semanticLevelForZoom(0.3)).toBe('normal');
    expect(semanticLevelForZoom(0.6)).toBe('normal');
    expect(semanticLevelForZoom(1)).toBe('detail');
  });

  test('projects world coordinates without scaling node contents', () => {
    expect(worldToScreen({ x: 100, y: 80 }, { x: 20, y: -10, zoom: 0.5 })).toEqual({ x: 70, y: 30 });
  });

  test('fits the world inside the circular viewport padding', () => {
    const camera = fitCamera({ width: 1440, height: 900 }, { width: 1200, height: 900 });
    expect(camera.x).toBeGreaterThanOrEqual(42);
    expect(camera.y).toBeGreaterThanOrEqual(42);
    expect(camera.x + 1200 * camera.zoom).toBeLessThanOrEqual(1398);
    expect(camera.y + 900 * camera.zoom).toBeLessThanOrEqual(858);
  });

  test('keeps a distinguishing suffix in overview labels', () => {
    expect(compactAgentName('Connector 02')).toBe('CONNE 02');
    expect(compactAgentName('Orchestrator')).toBe('ORCHESTR');
  });
});
