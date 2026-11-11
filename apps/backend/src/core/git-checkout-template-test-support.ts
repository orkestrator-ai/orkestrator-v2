/**
 * A committed Git checkout for fixtures that need a real repository but not a
 * particular one: one `main` branch, one commit of `README.md`, and a local
 * identity. Building it is seven Git spawns, so each test file builds it once
 * and every fixture gets its own copy. A copied repository holds no absolute
 * paths and shares no objects with its source, so worktrees, branches and
 * commits made in one copy never reach another.
 */
import { promises as fs, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand } from "./shell.js";

/**
 * Keyed by the temporary directory: the test preload gives each file its own,
 * and removes it with everything in it once the file is done.
 */
const templates = new Map<string, Promise<string>>();

function committedCheckoutTemplate(): Promise<string> {
  const tmp = os.tmpdir();
  const cached = templates.get(tmp);
  if (cached) return cached;
  const building = (async () => {
    const checkout = await fs.mkdtemp(path.join(tmp, "ork-checkout-template-"));
    // The preload's directory goes with the file; this covers any other runner.
    process.once("exit", () => rmSync(checkout, { recursive: true, force: true }));
    await runCommand("git", ["init", "-b", "main"], { cwd: checkout });
    await runCommand("git", ["config", "user.email", "test@example.invalid"], { cwd: checkout });
    await runCommand("git", ["config", "user.name", "Orkestrator Test"], { cwd: checkout });
    // Without these the commit starts detached auto-maintenance, which creates
    // and removes `.git/objects/maintenance.lock` while a copy may be listing
    // the directory, failing it with ENOENT (flake 9936). Copies keep the
    // config, so commits in them start none either.
    await runCommand("git", ["config", "maintenance.auto", "false"], { cwd: checkout });
    await runCommand("git", ["config", "gc.auto", "0"], { cwd: checkout });
    await fs.writeFile(path.join(checkout, "README.md"), "initial\n");
    await runCommand("git", ["add", "README.md"], { cwd: checkout });
    await runCommand("git", ["commit", "-m", "initial"], { cwd: checkout });
    return checkout;
  })();
  templates.set(tmp, building);
  building.catch(() => templates.delete(tmp));
  return building;
}

/** Copies the committed checkout to `destination`, which must not exist yet. */
export async function copyCommittedCheckout(destination: string): Promise<string> {
  await fs.cp(await committedCheckoutTemplate(), destination, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  return destination;
}
