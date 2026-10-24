import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtensionRunner, discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

const directories: string[] = [];
afterAll(async () => {
  await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
});

/** An extension file whose command tries every dialog and records the answers. */
const WIZARD_EXTENSION = `
export default function (pi) {
  pi.registerCommand("wizard", {
    description: "Interactive setup",
    handler: async (_args, ctx) => {
      const seen = { hasUI: ctx.hasUI };
      seen.confirm = await ctx.ui.confirm("Proceed?", "This needs an answer");
      seen.select = await ctx.ui.select("Pick one", ["a", "b"]);
      seen.input = await ctx.ui.input("Name?");
      seen.editor = await ctx.ui.editor("Edit");
      seen.custom = await ctx.ui.custom(() => undefined);
      globalThis.__orkestratorWizardSeen = seen;
    },
  });
}
`;

/*
 * Pins the headless extension semantics this bridge relies on, against the
 * real SDK rather than a fake (0016 item 4). `bindSessionExtensions` binds no
 * UI context, so an extension command must see `ctx.hasUI === false` and get
 * "no answer" from every dialog at once, never a hang and never a fake
 * answer. Pi also gives a registered command no way to say it needs a UI, so
 * the bridge cannot label such commands unavailable in advance; the bounded
 * outcome row (`settleCommandRun`) is the answer instead. If a pin bump adds
 * such a marker or changes the no-UI context, this fails.
 */
describe("Pi extension commands without a UI context (SDK pin)", () => {
  test("a command sees hasUI false and every dialog answers empty immediately", async () => {
    const root = await mkdtemp(join(tmpdir(), "ork-pi-headless-"));
    directories.push(root);
    const extensionPath = join(root, "wizard.js");
    await writeFile(extensionPath, WIZARD_EXTENSION);
    // A private cwd and agent dir, so no project or user extension joins in.
    const loaded = await discoverAndLoadExtensions([extensionPath], root, join(root, "agent"));
    expect(loaded.errors).toEqual([]);
    const runner = new ExtensionRunner(
      loaded.extensions,
      loaded.runtime,
      root,
      undefined as never,
      undefined as never,
    );

    expect(runner.hasUI()).toBe(false);
    const command = runner.getCommand("wizard");
    expect(command).toBeDefined();
    // No field says "this command needs a terminal UI".
    expect(Object.keys(command!).sort()).toEqual(
      ["description", "handler", "invocationName", "name", "sourceInfo"].sort(),
    );

    const started = Date.now();
    await command!.handler("", runner.createCommandContext());
    expect(Date.now() - started).toBeLessThan(1_000);
    expect((globalThis as { __orkestratorWizardSeen?: unknown }).__orkestratorWizardSeen).toEqual({
      hasUI: false,
      confirm: false,
      select: undefined,
      input: undefined,
      editor: undefined,
      custom: undefined,
    });
  });
});
