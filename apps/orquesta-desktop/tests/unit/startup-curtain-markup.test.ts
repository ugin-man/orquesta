import { describe, expect, test } from 'vitest';
import documentHtml from '../../index.html?raw';

describe('startup curtain markup', () => {
  test('ships the selected local logo before the React root', () => {
    expect(documentHtml).toContain('id="startup-curtain"');
    expect(documentHtml).toContain('./brand/orquesta-startup.jpg');
    expect(documentHtml.indexOf('id="startup-curtain"')).toBeLessThan(documentHtml.indexOf('id="root"'));
  });

  test('moves the logo upward and disables movement for reduced motion', () => {
    expect(documentHtml).toContain('translateY(-24px)');
    expect(documentHtml).toContain('prefers-reduced-motion: reduce');
  });
});
