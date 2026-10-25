import { afterEach, expect, jest, test } from "bun:test";
import { WorkerHighlightBackend } from "./client";
import type { HighlightRequest, HighlightResponse } from "./protocol";
const OriginalWorker = globalThis.Worker;
class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((event: { data: HighlightResponse }) => void) | null = null;
  onerror: ((event: { preventDefault(): void }) => void) | null = null;
  requests: HighlightRequest[] = [];
  terminated = false;
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(request: HighlightRequest) {
    this.requests.push(request);
  }
  terminate() {
    this.terminated = true;
  }
  answer(
    response:
      | Omit<Extract<HighlightResponse, { ok: true }>, "id">
      | Omit<Extract<HighlightResponse, { ok: false }>, "id">,
  ) {
    this.onmessage?.({ data: { id: this.requests.at(-1)!.id, ...response } });
  }
}
afterEach(() => {
  globalThis.Worker = OriginalWorker;
  FakeWorker.all = [];
  jest.useRealTimers();
});
function create() {
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  return new WorkerHighlightBackend();
}
const input = { lang: "typescript", theme: "dark", code: "const x = 1" } as const;
test("abort removes pending work and ignores a late worker response", async () => {
  const backend = create();
  const abort = new AbortController();
  const request = backend.highlight(input, abort.signal);
  const rejected = request.catch((error: unknown) => error);
  abort.abort();
  expect(await rejected).toMatchObject({ name: "AbortError" });
  FakeWorker.all[0]!.answer({ ok: true, lines: [], stateId: "stale" });
  const next = backend.highlight(input, new AbortController().signal);
  FakeWorker.all[0]!.answer({ ok: true, lines: [[{ c: input.code }]], stateId: "next" });
  await expect(next).resolves.toMatchObject({ stateId: "next" });
});
test("timeouts and crashes respawn, bound consecutive failures and reset allows recovery", async () => {
  jest.useFakeTimers();
  const backend = create();
  for (let attempt = 0; attempt < 3; attempt++) {
    const pending = backend.highlight(input, new AbortController().signal);
    const rejected = pending.catch((error: unknown) => error);
    const worker = FakeWorker.all.at(-1)!;
    if (attempt === 0) jest.advanceTimersByTime(10_000);
    else worker.onerror?.({ preventDefault() {} });
    expect(await rejected).toBeInstanceOf(Error);
    expect(worker.terminated).toBe(true);
  }
  await expect(backend.highlight(input, new AbortController().signal)).rejects.toThrow(
    "repeated failures",
  );
  expect(FakeWorker.all).toHaveLength(3);
  backend.reset();
  const recovered = backend.highlight(
    { ...input, resumeStateId: "before-crash" },
    new AbortController().signal,
  );
  FakeWorker.all.at(-1)!.answer({ ok: false, error: "state-missing" });
  await expect(recovered).rejects.toMatchObject({ name: "HighlightStateMissingError" });
  const full = backend.highlight(input, new AbortController().signal);
  FakeWorker.all.at(-1)!.answer({ ok: true, lines: [[{ c: input.code }]], stateId: "fresh" });
  await expect(full).resolves.toMatchObject({ stateId: "fresh" });
});
