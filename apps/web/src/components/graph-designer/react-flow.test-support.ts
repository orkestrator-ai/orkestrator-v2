/**
 * React Flow under happy-dom (canvas spike, docs/architecture/graphs.md):
 * nodes render, but edges only appear once nodes are measured, and happy-dom
 * has no layout. These stubs give every element a size, report it through an
 * asynchronous ResizeObserver, and provide the `DOMMatrixReadOnly` React Flow
 * reads its zoom from. Geometry itself is asserted in Playwright.
 */

const NODE_SIZE = { width: 240, height: 120 };
const VIEWPORT_SIZE = { width: 1200, height: 800 };

function sizeOf(element: Element): { width: number; height: number } {
  return element.classList?.contains("react-flow__node") ? NODE_SIZE : VIEWPORT_SIZE;
}

class StubResizeObserver {
  private readonly targets = new Set<Element>();
  private disconnected = false;

  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(target: Element) {
    this.targets.add(target);
    // Real observers report after layout, never synchronously.
    setTimeout(() => {
      if (this.disconnected || !this.targets.has(target)) return;
      const { width, height } = sizeOf(target);
      this.callback(
        [
          {
            target,
            contentRect: {
              width,
              height,
              x: 0,
              y: 0,
              top: 0,
              left: 0,
              right: width,
              bottom: height,
            },
            borderBoxSize: [{ inlineSize: width, blockSize: height }],
            contentBoxSize: [{ inlineSize: width, blockSize: height }],
            devicePixelContentBoxSize: [],
          } as unknown as ResizeObserverEntry,
        ],
        this as unknown as ResizeObserver,
      );
    }, 0);
  }

  unobserve(target: Element) {
    this.targets.delete(target);
  }

  disconnect() {
    this.disconnected = true;
    this.targets.clear();
  }
}

class StubDOMMatrixReadOnly {
  readonly m22: number = 1;
  readonly a: number = 1;
  readonly d: number = 1;
  readonly e: number = 0;
  readonly f: number = 0;
}

/** Installs the stubs; returns a function that restores the originals. */
export function installReactFlowDomStubs(): () => void {
  const globals = globalThis as Record<string, unknown>;
  const previousObserver = globals.ResizeObserver;
  const previousMatrix = globals.DOMMatrixReadOnly;
  const proto = HTMLElement.prototype;
  const previousWidth = Object.getOwnPropertyDescriptor(proto, "offsetWidth");
  const previousHeight = Object.getOwnPropertyDescriptor(proto, "offsetHeight");
  globals.ResizeObserver = StubResizeObserver;
  globals.DOMMatrixReadOnly = StubDOMMatrixReadOnly;
  Object.defineProperty(proto, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return sizeOf(this).width;
    },
  });
  Object.defineProperty(proto, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return sizeOf(this).height;
    },
  });
  return () => {
    globals.ResizeObserver = previousObserver;
    globals.DOMMatrixReadOnly = previousMatrix;
    if (previousWidth) Object.defineProperty(proto, "offsetWidth", previousWidth);
    else delete (proto as unknown as Record<string, unknown>).offsetWidth;
    if (previousHeight) Object.defineProperty(proto, "offsetHeight", previousHeight);
    else delete (proto as unknown as Record<string, unknown>).offsetHeight;
  };
}
