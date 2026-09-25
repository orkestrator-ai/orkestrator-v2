import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { waitFor } from "@testing-library/react";
import { webAnnotationPageKey } from "@orkestrator/protocol/web-annotations";
import { fixturePage, fixtureRequest } from "@orkestrator/protocol/web-annotations-fixtures";
import {
  FakeWebAnnotationBackend,
  fixtureCapabilities,
  installFakeOrkestrator,
  invokeMock,
} from "@/test/web-annotation-fakes";
import {
  getWebAnnotationCache,
  listQueryKey,
  useWebAnnotationStore,
  WEB_ANNOTATION_CACHE_LIMITS,
  type ListQuery,
} from "@/stores/webAnnotationStore";
import {
  acquireWebAnnotationSync,
  refreshAllWebAnnotationCapabilities,
  registerWebAnnotationList,
  resetWebAnnotationSyncForTests,
} from "./sync";

const FIRST: ListQuery = {
  filter: { pageKey: webAnnotationPageKey(fixturePage), state: "open" },
  cursor: null,
  limit: 1,
};

let bus: ReturnType<typeof installFakeOrkestrator>;
let backend: FakeWebAnnotationBackend;
const releases: Array<() => void> = [];

describe("web annotation sync recovery", () => {
  beforeEach(() => {
    resetWebAnnotationSyncForTests();
    bus = installFakeOrkestrator();
    backend = new FakeWebAnnotationBackend("env-1").install();
  });
  afterEach(() => {
    for (const release of releases.splice(0)) release();
    resetWebAnnotationSyncForTests();
    bus.restore();
    invokeMock.mockImplementation(() => Promise.resolve());
  });

  test("a rejected stale cursor refetches the first page automatically", async () => {
    backend.seed({ id: "annotation-a" });
    backend.seed({ id: "annotation-b" });
    const handle = acquireWebAnnotationSync("env-1", { visible: true });
    releases.push(handle.release);
    await waitFor(() => expect(getWebAnnotationCache("env-1").sync.status).toBe("ready"));
    const second: ListQuery = { ...FIRST, cursor: "cursor:1" };
    backend.fail("web_annotations_list", new Error("List cursor is stale"));
    const registration = registerWebAnnotationList("env-1", second);
    releases.push(registration.release);
    await waitFor(() =>
      expect(getWebAnnotationCache("env-1").lists.get(listQueryKey(second))?.error).toBe(
        "stale-cursor",
      ),
    );
    // Page one was fetched and installed without waiting for the view.
    const firstPage = getWebAnnotationCache("env-1").lists.get(listQueryKey(FIRST));
    expect(firstPage?.status).toBe("ready");
    expect(firstPage?.ids).toEqual(["annotation-a"]);
  });

  test("a rollout change to disabled is picked up and stops reads", async () => {
    backend.seed({ id: "annotation-a" });
    const handle = acquireWebAnnotationSync("env-1", { visible: true });
    releases.push(handle.release);
    await waitFor(() => expect(getWebAnnotationCache("env-1").sync.status).toBe("ready"));
    backend.capabilities = {
      ...fixtureCapabilities({ read: false, author: false, dispatch: false }),
      mode: "disabled",
    };
    const listsBefore = backend.callsOf("web_annotations_list").length;
    refreshAllWebAnnotationCapabilities();
    await waitFor(() => expect(getWebAnnotationCache("env-1").capabilities?.mode).toBe("disabled"));
    expect(backend.callsOf("web_annotations_list")).toHaveLength(listsBefore);
    // Re-enabled: reads resume with a fresh snapshot.
    backend.capabilities = { ...fixtureCapabilities(), mode: "enabled" };
    refreshAllWebAnnotationCapabilities();
    await waitFor(() =>
      expect(backend.callsOf("web_annotations_list").length).toBeGreaterThan(listsBefore),
    );
  });
});

describe("web annotation cache bounds", () => {
  afterEach(() => useWebAnnotationStore.getState().reset());

  test("requests and results are bounded, keeping ones an open thread shows", () => {
    const store = useWebAnnotationStore.getState();
    const kept = fixtureRequest("running", { id: "request-kept" });
    store.installThread("env-1", "annotation-1", {
      status: "ready",
      error: null,
      data: {
        generation: "g",
        revision: 1,
        annotation: backendAnnotation(),
        capture: null,
        entries: [],
        nextEntrySequence: null,
        requests: [kept],
        results: [],
      },
    });
    const many = Array.from({ length: WEB_ANNOTATION_CACHE_LIMITS.requests + 25 }, (_, index) =>
      fixtureRequest("completed", { id: `request-${index}` }),
    );
    store.installRequests("env-1", many);
    const requests = getWebAnnotationCache("env-1").requests;
    expect(requests.size).toBeLessThanOrEqual(WEB_ANNOTATION_CACHE_LIMITS.requests);
    expect(requests.has("request-kept")).toBe(true);
    // The newest incoming requests are kept; the oldest were evicted.
    expect(requests.has(`request-${many.length - 1}`)).toBe(true);
    expect(requests.has("request-0")).toBe(false);
  });
});

function backendAnnotation() {
  const fake = new FakeWebAnnotationBackend("env-1");
  return fake.seed({ id: "annotation-1" });
}
