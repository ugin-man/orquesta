import '@testing-library/jest-dom/vitest';

class TestResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: TestResizeObserver,
  });
}

if (typeof HTMLElement.prototype.scrollTo !== 'function') {
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value(optionsOrX?: ScrollToOptions | number, y?: number) {
      if (typeof optionsOrX === 'number') {
        this.scrollLeft = optionsOrX;
        this.scrollTop = y ?? 0;
        return;
      }
      if (typeof optionsOrX?.left === 'number') this.scrollLeft = optionsOrX.left;
      if (typeof optionsOrX?.top === 'number') this.scrollTop = optionsOrX.top;
    },
  });
}
