import { describe, expect, test } from 'vitest';
import documentHtml from '../../index.html?raw';

describe('startup curtain markup', () => {
  test('ships the selected local logo before the React root', () => {
    expect(documentHtml).toContain('id="startup-curtain"');
    expect(documentHtml).toContain('./brand/orquesta-startup.png');
    expect(documentHtml.indexOf('id="startup-curtain"')).toBeLessThan(documentHtml.indexOf('id="root"'));
  });

  test('uses the same warm canvas and paper texture as the home screen', () => {
    expect(documentHtml).toContain('#f3f0e8');
    expect(documentHtml).toContain('radial-gradient(circle at 50% 45%');
    expect(documentHtml).toContain('./reference/paper-grain.png');
  });

  test('moves the logo upward and disables movement for reduced motion', () => {
    expect(documentHtml).toContain('translateY(-24px)');
    expect(documentHtml).toContain('prefers-reduced-motion: reduce');
  });
});
