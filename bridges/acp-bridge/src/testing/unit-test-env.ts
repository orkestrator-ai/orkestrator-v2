/**
 * Import this **before** any bridge source module in an in-process unit test.
 *
 * `acp-context.ts` resolves the bridge's configuration at module scope, and
 * `loadAcpProviderConfig` throws when provider configuration is absent. Every
 * other ACP test drives a spawned child, where `spawnBridge` supplies it, so a test
 * that imports a bridge module directly is the only caller that has to set it
 * up itself. Without this the whole file aborts before a single test runs, and
 * a suite reports one error rather than a failed assertion.
 *
 * ESM evaluates imports in source order, so a bare `import` of this module
 * ahead of the module under test is what makes the assignment win the race.
 * Existing values are left alone: a run that deliberately selects a provider
 * keeps it.
 */
process.env.ACP_PROVIDER ??= "cursor";
process.env.ACP_PROVIDER_CONFIG ??= JSON.stringify({
  id: "cursor",
  name: "Cursor test fixture",
  executable: process.execPath,
  argv: [],
  env: {},
  requiresAuthenticate: false,
  modeMap: { agent: "build", plan: "plan" },
  extensionPrefixes: ["cursor/"],
  acknowledgedExtensionMethods: ["cursor/task", "cursor/update_todos"],
  modelUpdateMethods: ["cursor/models/update"],
  sessionUpdateMethods: ["cursor/session/update"],
});
