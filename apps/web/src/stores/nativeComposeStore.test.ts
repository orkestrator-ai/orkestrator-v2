import { beforeEach, describe, expect, test } from "bun:test";
import {
  unassignedNativeComposePersistenceStore,
  useNativeComposeStore,
} from "./nativeComposeStore";

describe("nativeComposeStore", () => {
  beforeEach(() => {
    useNativeComposeStore.setState({ drafts: new Map() });
  });

  test("round-trips only execution profiles the unassigned launcher can display", () => {
    const sessionKey = "env-env-1:tab-profile";
    const persistence = unassignedNativeComposePersistenceStore.getState();

    persistence.setDraftMetadata?.(sessionKey, {
      platform: "opencode",
      executionProfileId: "custom-reviewer",
    });
    expect(useNativeComposeStore.getState().drafts.get(sessionKey)).toMatchObject({
      platform: "opencode",
      executionProfileId: undefined,
    });

    persistence.setDraftMetadata?.(sessionKey, {
      platform: "opencode",
      executionProfileId: "plan",
    });
    expect(useNativeComposeStore.getState().drafts.get(sessionKey)).toMatchObject({
      platform: "opencode",
      executionProfileId: "plan",
    });
    expect(
      unassignedNativeComposePersistenceStore.getState().draftMetadata?.get(sessionKey),
    ).toMatchObject({ executionProfileId: "plan" });
  });
});
