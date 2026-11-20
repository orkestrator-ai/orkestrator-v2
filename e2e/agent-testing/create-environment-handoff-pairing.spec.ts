/**
 * Run against a fresh credential-free `dev:test --fixture` profile with
 * ORKESTRATOR_AGENT_TEST_HANDOFF_PAIRING=1. The leaf is a published backend
 * with a disposable clone of the test profile's fixture checkout.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, fetchModulesOutsideChromium, test, type Page } from "./browser-test";
import {
  installPublishedBackend,
  startPairingBackend,
  type PairingBackend,
} from "./design-renderer-pairing-support";
import { attachLeaf, gateway, loginUrl, profileStatus, type Gateway } from "./scope-proof-support";

const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "";
const previousRelease = "2.39.8-beta";
const leafName = "Prior release leaf";
const repository = "orkestrator-fixtures/handoff";

test.skip(
  process.env.ORKESTRATOR_AGENT_TEST_HANDOFF_PAIRING !== "1" || !profile,
  "Requires an isolated dev:test profile with a fixture and the handoff pairing opt-in.",
);
test.use({ trace: "off", viewport: { width: 1440, height: 940 } });

function leafGateway(backend: PairingBackend): Gateway {
  const { origin, token } = backend;
  return {
    profile: leafName,
    origin,
    secret: () => token,
    async invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
      const response = await fetch(`${origin}/__orkestrator/invoke`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", origin },
        body: JSON.stringify({ command, args }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`${command}: HTTP ${response.status}`);
      return ((await response.json()) as { result: T }).result;
    },
  };
}

function createDialog(page: Page) {
  return page.getByRole("dialog", { name: /Create Ork \(environment\)/ });
}

async function openSourceForm(page: Page, url: string) {
  for (const name of ["Continue without Docker", "Continue without GitHub CLI"]) {
    const dismiss = page.getByRole("button", { name, exact: true });
    await page.addLocatorHandler(dismiss, (button) => button.click());
  }
  const hostWarning = page.getByRole("dialog", { name: /Docker containers can't reach/ });
  await page.addLocatorHandler(hostWarning, (dialog) =>
    dialog.getByRole("button", { name: "Close", exact: true }).first().click(),
  );
  await page.goto(url);
  const open = page.getByRole("button", { name: `New environment in ${repository}`, exact: true });
  await open.click({ timeout: 30_000 });
  const dialog = createDialog(page);
  await dialog.getByRole("button", { name: "Local", exact: true }).click();
  return dialog;
}

async function chooseLeaf(page: Page, nodeId: string) {
  await createDialog(page).getByRole("combobox", { name: "Machine" }).click();
  await page
    .getByRole("option", { name: leafName, exact: true })
    .and(page.locator(`[data-create-environment-machine="node:${nodeId}"]`))
    .click();
}

interface Project {
  id: string;
  gitUrl: string;
  localPath: string;
}

interface Environment {
  name: string;
  projectId: string;
}

test("Create Environment switches to and submits on a backend one release behind", async ({
  browser,
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const status = profileStatus(profile);
  const command = gateway(profile);
  const source = (await command.invoke<Project[]>("get_projects")).find(
    (project) => project.localPath === status.testProject,
  );
  if (!source) throw new Error("The isolated profile has no fixture project");

  const scratch = await mkdtemp(path.join(tmpdir(), "ork-create-handoff-"));
  const checkout = path.join(scratch, "checkout");
  let backend: PairingBackend | undefined;
  let nodeId: string | undefined;
  try {
    const packageRoot = await installPublishedBackend(
      previousRelease,
      path.join(scratch, "package"),
    );
    backend = await startPairingBackend(
      { kind: "published", packageRoot },
      path.join(scratch, "leaf"),
    );
    expect(backend.version).toBe(previousRelease);
    const leaf = leafGateway(backend);
    ({ nodeId } = await leaf.invoke<{ nodeId: string }>("get_node_status"));
    const clone = spawnSync("git", ["clone", "--no-hardlinks", source.localPath, checkout], {
      encoding: "utf8",
    });
    expect(clone.status, clone.stderr.trim()).toBe(0);
    const target = await leaf.invoke<Project>("add_project", {
      gitUrl: source.localPath,
      localPath: checkout,
    });
    expect(target.id).not.toBe(source.id);
    const remote = `https://github.com/${repository}.git`;
    await command.invoke("update_project", { projectId: source.id, updates: { gitUrl: remote } });
    await leaf.invoke("update_project", { projectId: target.id, updates: { gitUrl: remote } });
    const backendProfile = await leaf.invoke<{ revision: number }>("get_backend_profile");
    await leaf.invoke("update_backend_profile", {
      expectedRevision: backendProfile.revision,
      displayName: leafName,
      colorToken: "blue",
    });
    await attachLeaf(command, leaf);

    const dialog = await openSourceForm(page, loginUrl(profile));
    const environmentName = "mixed-release-handoff";
    await dialog.getByLabel("Environment name (optional)").fill(environmentName);
    await dialog.getByRole("button", { name: "Interactive", exact: true }).click();
    await dialog.getByLabel("Initial prompt (optional)").fill("Keep the handoff text");
    const prompt = dialog.getByLabel("Initial prompt (optional)");
    await dialog.screenshot({
      path: testInfo.outputPath("source-form.png"),
      mask: [prompt],
      maskColor: "#171717",
    });

    await chooseLeaf(page, nodeId);
    await expect(dialog.getByRole("combobox", { name: "Machine" })).toHaveText(leafName);
    await expect(dialog.getByText(`Git worktree on ${leafName}`, { exact: true })).toBeVisible();
    await expect(dialog.getByLabel("Environment name (optional)")).toHaveValue(environmentName);
    await expect(dialog.getByLabel("Initial prompt (optional)")).toHaveValue(
      "Keep the handoff text",
    );
    await expect(dialog.getByRole("button", { name: "Interactive", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await dialog.screenshot({
      path: testInfo.outputPath("destination-form.png"),
      mask: [prompt],
      maskColor: "#171717",
    });
    await dialog.getByRole("checkbox", { name: "Launch agent" }).uncheck();
    const [reply] = await Promise.all([
      page.waitForResponse(
        (response) => {
          const request = response.request();
          return (
            request.method() === "POST" &&
            new URL(request.url()).pathname.endsWith("/__orkestrator/invoke") &&
            request.postDataJSON()?.command === "create_environment"
          );
        },
        { timeout: 15_000 },
      ),
      dialog.getByRole("button", { name: "Create environment", exact: true }).click(),
    ]);
    const replyBody = await reply.json();
    expect(reply.ok(), String(replyBody?.error ?? "Create request failed")).toBe(true);
    expect(replyBody.result).toMatchObject({ projectId: target.id, name: environmentName });
    await expect(dialog).toBeHidden();
    const read = (node: Gateway, projectId: string) =>
      node.invoke<Environment[]>("get_environments", { projectId });
    await expect
      .poll(() => read(leaf, target.id))
      .toContainEqual(expect.objectContaining({ name: environmentName, projectId: target.id }));
    expect(await read(command, source.id)).not.toContainEqual(
      expect.objectContaining({ name: environmentName }),
    );
    await page.reload();
    await expect(page.getByText(environmentName, { exact: true }).first()).toBeVisible();

    // A cold workspace can hydrate after its advertised checkout disappears.
    // Keep the real portal summary and replace only this tab's project read.
    // A second signed-in context, routed like the fixture's own, so its
    // modules load outside Chromium's network path too.
    const recoveryContext = await browser.newContext({
      storageState: await page.context().storageState(),
      viewport: { width: 1440, height: 940 },
    });
    try {
      await fetchModulesOutsideChromium(recoveryContext);
      const recoveryPage = await recoveryContext.newPage();
      await recoveryPage.route("**/__orkestrator/invoke", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const isLeaf = url.origin === leaf.origin || url.pathname.includes(`/nodes/${nodeId}/`);
        if (
          !isLeaf ||
          request.method() !== "POST" ||
          request.postDataJSON()?.command !== "get_projects"
        ) {
          return route.fallback();
        }
        const response = await route.fetch();
        const body = await response.json();
        await route.fulfill({ response, json: { ...body, result: [] } });
      });
      const recovered = await openSourceForm(recoveryPage, status.browserUrl);
      await recovered.getByLabel("Environment name (optional)").fill("Keep my draft");
      await recovered.getByRole("checkbox", { name: "Launch agent" }).uncheck();
      await chooseLeaf(recoveryPage, nodeId);
      const failure = recoveryPage.getByText(
        `Could not open the new environment form on ${leafName}`,
      );
      await expect(failure).toBeInViewport({ ratio: 1 });
      await expect(recovered.getByLabel("Environment name (optional)")).toHaveValue(
        "Keep my draft",
      );
      await expect(recovered.getByRole("checkbox", { name: "Launch agent" })).not.toBeChecked();
      await recoveryPage.screenshot({
        path: testInfo.outputPath("recovered-form.png"),
        animations: "disabled",
      });
    } finally {
      await recoveryContext.close();
    }
  } finally {
    if (nodeId) await command.invoke("forget_node", { nodeId }).catch(() => undefined);
    await command
      .invoke("update_project", {
        projectId: source.id,
        updates: { gitUrl: source.gitUrl },
      })
      .catch(() => undefined);
    await backend?.stop();
    await rm(scratch, { recursive: true, force: true });
  }
});
