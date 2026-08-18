import { beforeEach, describe, expect, test } from "bun:test";
import {
  unassignedNativeComposePersistenceStore,
  useNativeComposeStore,
} from "./nativeComposeStore";

describe("nativeComposeStore", () => {
  beforeEach(() => {
    useNativeComposeStore.setState({ drafts: new Map() });
  });

  test("round-trips a provider's own execution profile name", () => {
    const sessionKey = "env-env-1:tab-profile";
    const persistence = unassignedNativeComposePersistenceStore.getState();

    // Execution profiles are the provider's primary-agent names, which users
    // can rename. Narrowing this to the launcher's two defaults would discard a
    // perfectly valid selection on restore.
    persistence.setDraftMetadata?.(sessionKey, {
      platform: "opencode",
      executionProfileId: "custom-reviewer",
    });
    expect(useNativeComposeStore.getState().drafts.get(sessionKey)).toMatchObject({
      platform: "opencode",
      executionProfileId: "custom-reviewer",
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

  test("rejects execution profile ids that are blank, oversized, or not strings", () => {
    const persistence = unassignedNativeComposePersistenceStore.getState();

    for (const [index, executionProfileId] of [
      "   ",
      "x".repeat(257),
      42,
      { id: "plan" },
      null,
    ].entries()) {
      const sessionKey = `env-env-1:tab-invalid-${index}`;
      persistence.setDraftMetadata?.(sessionKey, {
        platform: "opencode",
        executionProfileId,
      });
      expect(
        useNativeComposeStore.getState().drafts.get(sessionKey)?.executionProfileId,
      ).toBeUndefined();
    }

    // The boundary itself is accepted, so the cap rejects only what exceeds it.
    persistence.setDraftMetadata?.("env-env-1:tab-max", {
      platform: "opencode",
      executionProfileId: "x".repeat(256),
    });
    expect(
      useNativeComposeStore.getState().drafts.get("env-env-1:tab-max")?.executionProfileId,
    ).toBe("x".repeat(256));
  });

  test("restores a draft that carries only an execution profile", () => {
    const sessionKey = "env-env-1:tab-profile-only";
    unassignedNativeComposePersistenceStore.getState().setDraftMetadata?.(sessionKey, {
      executionProfileId: "plan",
    });
    expect(useNativeComposeStore.getState().drafts.get(sessionKey)?.executionProfileId).toBe(
      "plan",
    );
  });
});
