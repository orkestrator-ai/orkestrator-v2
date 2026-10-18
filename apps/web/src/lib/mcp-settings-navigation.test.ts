import { afterEach, expect, test } from "bun:test";

import {
  peekMcpSettingsIntent,
  requestMcpServerSettings,
  settleMcpSettingsIntent,
} from "./mcp-settings-navigation";

afterEach(() => {
  settleMcpSettingsIntent(peekMcpSettingsIntent());
});

test("settling a stale render preserves a newer request with the same values", () => {
  const older = { provider: "claude" as const, environmentId: "environment-a" };
  requestMcpServerSettings(older);
  const renderedIntent = peekMcpSettingsIntent();
  expect(renderedIntent).toBe(older);

  // A second deep link arrives before the first render's effect commits.
  // Equal values still represent a distinct request that must be preserved.
  const newer = { ...older };
  requestMcpServerSettings(newer);
  settleMcpSettingsIntent(renderedIntent);

  expect(peekMcpSettingsIntent()).toBe(newer);
  settleMcpSettingsIntent(newer);
  expect(peekMcpSettingsIntent()).toBeNull();
});
