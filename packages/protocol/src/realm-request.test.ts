import { describe, expect, test } from "bun:test";
import {
  parseRealmRequest,
  parseRealmRequestSearch,
  REALM_BOARD_TABS,
  REALM_DIALOGS,
  REALM_WORK_TYPES,
  realmRequestToSearch,
  type RealmOpenRequest,
  type RealmWorkTarget,
} from "./realm-request.js";

/** Encode into a URL and parse it back, as a realm opened on the request does. */
function roundTrip(request: RealmOpenRequest): RealmOpenRequest {
  const url = new URL("https://node.test/");
  url.search = realmRequestToSearch(request).toString();
  return parseRealmRequestSearch(url.searchParams);
}

const base = { projectId: "p", environmentId: "e" };

const WORK_TARGETS: Record<(typeof REALM_WORK_TYPES)[number], RealmWorkTarget> = {
  "worker-tab": { type: "worker-tab", ...base, tabId: "t" },
  build: { type: "build", ...base, pipelineId: "pl" },
  review: { type: "review", ...base, workflowId: "wf" },
  "graph-run": { type: "graph-run", ...base, runId: "r" },
};

describe("realm request", () => {
  test("every board tab, dialog, work target type and the bug report survive the URL", () => {
    for (const boardTab of REALM_BOARD_TABS) {
      expect(roundTrip({ projectId: "p", boardTab })).toEqual({ projectId: "p", boardTab });
    }
    for (const dialog of REALM_DIALOGS) {
      expect(roundTrip({ ...base, dialog })).toEqual({ ...base, dialog });
    }
    for (const type of REALM_WORK_TYPES) {
      const workTarget = WORK_TARGETS[type];
      expect(roundTrip({ ...base, workTarget })).toEqual({ ...base, workTarget });
    }
    expect(roundTrip({ ...base, workTarget: { type: "worker-tab", ...base } })).toEqual({
      ...base,
      workTarget: { type: "worker-tab", ...base },
    });
    expect(roundTrip({ bugReport: true })).toEqual({ bugReport: true });
    expect(roundTrip({ addProject: true, createEnvironmentProjectId: "p" })).toEqual({
      addProject: true,
      createEnvironmentProjectId: "p",
    });
  });

  test("each field needs what it is for, and unknown values are dropped", () => {
    expect(parseRealmRequest({ environmentId: "e", boardTab: "home" })).toEqual({});
    expect(parseRealmRequest({ projectId: "p", boardTab: "invalid" })).toEqual({ projectId: "p" });
    expect(parseRealmRequest({ projectId: "p", dialog: "environment-rebuild" })).toEqual({
      projectId: "p",
    });
    expect(parseRealmRequest({ projectId: "p", dialog: "delete-project" })).toEqual({
      projectId: "p",
      dialog: "delete-project",
    });
    expect(parseRealmRequest({ ...base, dialog: "unknown" })).toEqual(base);
    expect(parseRealmRequest({ projectId: "x".repeat(300) })).toEqual({});
    expect(parseRealmRequest({ bugReport: "1", addProject: 1 })).toEqual({});
    expect(parseRealmRequest(null)).toEqual({});
  });

  test("a work target is refused off the request's own project and environment", () => {
    const review = WORK_TARGETS.review;
    expect(parseRealmRequest({ ...base, workTarget: { ...review, projectId: "q" } })).toEqual(base);
    expect(parseRealmRequest({ ...base, workTarget: { ...review, environmentId: "f" } })).toEqual(
      base,
    );
    expect(parseRealmRequest({ projectId: "p", workTarget: review })).toEqual({ projectId: "p" });
    expect(parseRealmRequest({ ...base, workTarget: { type: "review", ...base } })).toEqual(base);
    expect(parseRealmRequest({ ...base, workTarget: { type: "pull-request", ...base } })).toEqual(
      base,
    );
  });

  test("the encoder writes only accepted fields", () => {
    expect(
      Object.fromEntries(
        realmRequestToSearch({
          environmentId: "e",
          workTarget: WORK_TARGETS.review,
          extra: "x",
        } as RealmOpenRequest),
      ),
    ).toEqual({});
    const search = new URLSearchParams({ project: "p", environment: "e", workType: "unknown" });
    search.set("workId", "w");
    expect(parseRealmRequestSearch(search)).toEqual(base);
  });
});
