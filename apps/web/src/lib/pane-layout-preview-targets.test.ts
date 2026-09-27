import { describe, expect, test } from "bun:test";
import {
  FIXTURE_BACKEND_INSTANCE_ID,
  FIXTURE_SERVICE_ID,
} from "@orkestrator/protocol/preview-contract-fixtures";
import {
  formatPreviewServiceUri,
  parsePreviewTabTarget,
} from "@orkestrator/protocol/preview-services";

import { createPersistedPaneLayoutInput } from "./pane-layout-persistence";
import { mergePersistedPaneLayouts } from "./pane-layout-merge";
import { reconcilePersistedLayout } from "./pane-layout-restore";
import { PANE_LAYOUT_VERSION, type PersistedPaneLayout } from "@/types/paneLayout";

const serviceUri = (path: string) =>
  formatPreviewServiceUri({
    backendInstanceId: FIXTURE_BACKEND_INSTANCE_ID,
    environmentId: "env-1",
    serviceId: FIXTURE_SERVICE_ID,
    path,
  });

function saved(url: string, history?: string[]): PersistedPaneLayout {
  return {
    version: PANE_LAYOUT_VERSION,
    environmentId: "env-1",
    containerId: "container-1",
    activePaneId: "pane",
    root: {
      kind: "leaf",
      id: "pane",
      activeTabId: "browser",
      tabs: [
        {
          id: "browser",
          type: "browser",
          browserData: { url, ...(history ? { history, historyIndex: 0 } : {}) },
        },
      ],
    },
    updatedAt: "2026-09-23T00:00:00.000Z",
    revision: 1,
  };
}

const context = { environmentId: "env-1", containerId: "container-1", isLocal: false };

describe("service tab persistence (layout v3)", () => {
  test("restore and save keep the service reference verbatim", () => {
    const restored = reconcilePersistedLayout(saved(serviceUri("/a?b=1#c")), context)!;
    const input = createPersistedPaneLayoutInput(restored);
    const tab = (input.root as { tabs: Array<{ browserData: { url: string } }> }).tabs[0]!;
    expect(parsePreviewTabTarget(tab.browserData.url)).toMatchObject({
      kind: "service",
      ref: { serviceId: FIXTURE_SERVICE_ID, path: "/a?b=1#c" },
    });
    // Nothing runtime-only is persisted: no loopback transport address or grant.
    expect(JSON.stringify(input)).not.toMatch(/127\.0\.0\.1|credential|grant/);
  });

  test("a legacy URL tab is read unchanged as a manual tab", () => {
    const restored = reconcilePersistedLayout(saved("http://localhost:49152/"), context)!;
    const tab = (
      createPersistedPaneLayoutInput(restored).root as {
        tabs: Array<{ browserData: { url: string } }>;
      }
    ).tabs[0]!;
    expect(parsePreviewTabTarget(tab.browserData.url)).toEqual({
      kind: "url",
      url: "http://localhost:49152/",
    });
  });

  test("a client that did not touch the tab cannot downgrade another client's service reference", () => {
    const base = createPersistedPaneLayoutInput(
      reconcilePersistedLayout(saved(serviceUri("/")), context)!,
    );
    // An older client restores and re-saves without understanding the target.
    const oldClient = createPersistedPaneLayoutInput(
      reconcilePersistedLayout(saved(serviceUri("/")), context)!,
    );
    const remote = createPersistedPaneLayoutInput(
      reconcilePersistedLayout(saved(serviceUri("/next")), context)!,
    );
    const merged = mergePersistedPaneLayouts(base, oldClient, remote);
    const tab = (merged.root as { tabs: Array<{ browserData: { url: string } }> }).tabs[0]!;
    expect(tab.browserData.url).toBe(serviceUri("/next"));
  });

  test("malformed service URIs are preserved as unsupported addresses, never reinterpreted", () => {
    const restored = reconcilePersistedLayout(saved("orkestrator-preview://service/bad"), context)!;
    const tab = (
      createPersistedPaneLayoutInput(restored).root as {
        tabs: Array<{ browserData: { url: string } }>;
      }
    ).tabs[0]!;
    expect(tab.browserData.url).toBe("orkestrator-preview://service/bad");
    expect(parsePreviewTabTarget(tab.browserData.url).kind).toBe("url");
  });
});
