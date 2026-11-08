import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type {
  MermaidRenderRequest,
  MermaidRenderResponse,
} from "@orkestrator/protocol/transcript-artifact-commands";
import { renderMermaidOnce, setMermaidSvgSanitizer } from "./mermaid-render";

const SVG = '<svg viewBox="0 0 200 100"><g class="node"><text>Input</text></g></svg>';

function ok(): MermaidRenderResponse {
  return {
    ok: true,
    svg: SVG,
    diagramType: "flowchart",
    rendererVersion: "test",
    svgBytes: SVG.length,
    svgElements: 3,
    edges: 0,
    renderDigest: "digest",
  };
}

/** An AbortSignal that counts its live `abort` listeners. */
function countingSignal(controller = new AbortController()) {
  const signal = controller.signal;
  const live = new Set<EventListenerOrEventListenerObject>();
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => {
    if (type === "abort") live.add(listener);
    add(type, listener, options);
  }) as AbortSignal["addEventListener"];
  signal.removeEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ) => {
    if (type === "abort") live.delete(listener);
    remove(type, listener, options);
  }) as AbortSignal["removeEventListener"];
  return { controller, signal, live };
}

beforeEach(() => {
  setMermaidSvgSanitizer((markup) => ({ svg: markup }));
});

afterEach(() => {
  setMermaidSvgSanitizer(null);
});

describe("renderMermaidOnce", () => {
  test("removes its abort listener once the render settles", async () => {
    const { signal, live } = countingSignal();
    const renderer = mock(async (_input: MermaidRenderRequest) => ok());

    for (let index = 0; index < 3; index += 1) {
      const preview = await renderMermaidOnce(renderer, "flowchart TD\n A-->B", "light", signal);
      expect(preview.svg).toBe(SVG);
    }

    expect(renderer).toHaveBeenCalledTimes(3);
    expect(live.size).toBe(0);
  });

  test("removes its abort listener when the render fails", async () => {
    const { signal, live } = countingSignal();
    const renderer = async (): Promise<MermaidRenderResponse> => ({
      ok: false,
      error: { code: "validation_failed", message: "bad diagram", retryClass: "after-edit" },
    });

    await expect(renderMermaidOnce(renderer, "nope", "dark", signal)).rejects.toThrow(
      "bad diagram",
    );
    expect(live.size).toBe(0);
  });

  test("an already-aborted signal rejects at once without calling the renderer", async () => {
    const controller = new AbortController();
    controller.abort();
    const renderer = mock(async (_input: MermaidRenderRequest) => ok());

    const started = Date.now();
    const error = await renderMermaidOnce(renderer, "flowchart TD", "light", controller.signal)
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect((error as DOMException).name).toBe("AbortError");
    expect(renderer).not.toHaveBeenCalled();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("an abort during the render rejects with AbortError and detaches", async () => {
    const { controller, signal, live } = countingSignal();
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    const renderer = () => {
      started();
      return new Promise<MermaidRenderResponse>(() => {});
    };

    const pending = renderMermaidOnce(renderer, "flowchart TD", "light", signal);
    await running;
    controller.abort();
    const error = await pending.then(
      () => null,
      (caught: unknown) => caught,
    );

    expect((error as DOMException).name).toBe("AbortError");
    expect(live.size).toBe(0);
  });
});
