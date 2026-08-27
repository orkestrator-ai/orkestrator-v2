import { describe, expect, mock, test } from "bun:test";
import {
  MODEL_CATALOG_REFRESHED_EVENT,
  refreshSettingsModelCatalog,
} from "./refresh-model-catalog";

function dependencies() {
  return {
    refreshGlobal: mock(async (agent) => ({ agent, modelCount: 1 })),
    refreshOpenCode: mock(async () => ({ agent: "opencode" as const, modelCount: 2 })),
    hydrate: mock(async () => undefined),
    dispatch: mock((_event: Event) => true),
  };
}

describe("settings model catalogue refresh", () => {
  test("requires a repository before invoking OpenCode", async () => {
    const deps = dependencies();

    await expect(refreshSettingsModelCatalog("opencode", null, deps)).rejects.toThrow(
      /select a repository/i,
    );
    expect(deps.refreshOpenCode).not.toHaveBeenCalled();
    expect(deps.hydrate).not.toHaveBeenCalled();
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  test("refreshes the selected OpenCode scope before hydrating and notifying", async () => {
    const deps = dependencies();

    await expect(refreshSettingsModelCatalog("opencode", "project-1", deps)).resolves.toEqual({
      agent: "opencode",
      modelCount: 2,
    });
    expect(deps.refreshOpenCode).toHaveBeenCalledWith("project-1");
    expect(deps.refreshGlobal).not.toHaveBeenCalled();
    expect(deps.hydrate).toHaveBeenCalledTimes(1);
    expect(deps.dispatch.mock.calls[0]?.[0]?.type).toBe(MODEL_CATALOG_REFRESHED_EVENT);
  });

  test("does not hydrate or notify after a failed backend refresh", async () => {
    const deps = dependencies();
    deps.refreshGlobal.mockRejectedValueOnce(new Error("provider unavailable"));

    await expect(refreshSettingsModelCatalog("codex", null, deps)).rejects.toThrow(
      "provider unavailable",
    );
    expect(deps.hydrate).not.toHaveBeenCalled();
    expect(deps.dispatch).not.toHaveBeenCalled();
  });
});
