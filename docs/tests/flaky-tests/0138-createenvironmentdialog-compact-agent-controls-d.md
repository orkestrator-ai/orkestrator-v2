# CreateEnvironmentDialog compact agent controls default mode (`tests/unit/components/CreateEnvironmentDialog.test.tsx`)

- **ID:** 0138
- **Status:** resolved
- **Date observed:** 2026-08-26
- **Original command:** `bun test apps/backend/src/core/extension-discovery.test.ts bridges/acp-bridge/src/grok-runtime.test.ts apps/desktop/electron/agent-platform-selection.test.ts tests/unit/electron/toolchain-startup.test.ts tests/unit/electron/commands-registry-tools.test.ts tests/unit/components/CreateEnvironmentDialog.test.tsx tests/unit/components/EnvironmentSettingsDialog.test.tsx`
- **Worker configuration:** one Bun test process running seven explicitly selected files.
- **Failure:** `resolveAgentDefaults > shows the project name in the title and presents the compact agent controls in order` expected the Use TUI checkbox `data-state` to be `unchecked`, but received `checked` (duration: 18.29 ms).
- **Suite counts:** 179 total, 178 passed, 1 failed.
- **Isolated rerun:** `bun test tests/unit/components/CreateEnvironmentDialog.test.tsx` → 105 passed, 0 failed in 5.62 s.
- **Hypothesis:** the result depends on state shared with another file in the combined Bun process; the owning file resets enough state to pass in isolation, but the exact leaking state has not been identified.
