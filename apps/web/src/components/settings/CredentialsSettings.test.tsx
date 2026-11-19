import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type {
  CredentialConnection,
  CredentialGrantRecord,
  CredentialOverview,
} from "@orkestrator/protocol/agent-credentials";
import { dispatchResourceChange, resetResourceSync } from "@/lib/resource-sync";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import type { Environment, Project } from "@/types";
import { AccountMachineProvider } from "./account-machine";
import * as realBackend from "@/lib/backend";

function connection(overrides: Partial<CredentialConnection> = {}): CredentialConnection {
  return {
    id: "connection-1",
    name: "npm",
    description: "Publishing token",
    projectIds: null,
    httpHosts: ["registry.npmjs.org"],
    storage: "keychain",
    revision: 3,
    valueVersion: 1,
    createdAt: 1,
    updatedAt: 1,
    status: "ready",
    ...overrides,
  };
}

const grant: CredentialGrantRecord = {
  id: "grant-1",
  requestId: "request-1",
  environmentId: "env-1",
  projectId: "project-1",
  tabId: "tab-1",
  label: "Deploy token",
  source: { kind: "temporary" },
  use: "command",
  binding: { kind: "env", name: "DEPLOY_TOKEN" },
  runtime: { kind: "worktree", isolation: "trusted-local" },
  issuedAt: 1,
  expiresAt: Date.UTC(2026, 10, 19, 12, 0),
  maxUses: null,
  uses: 2,
  state: "active",
};

let overview: CredentialOverview;
function resetOverview() {
  overview = {
    vault: {
      durable: "keychain",
      canSave: true,
      detail: "Saved values are kept in this machine's system keychain.",
    },
    connections: [connection()],
    grants: [grant],
    operations: [],
  };
}
resetOverview();

const getCredentialOverview = mock(async () => overview);
const createCredentialConnection = mock(async (_input: unknown, _machine?: unknown) =>
  connection(),
);
const deleteCredentialConnection = mock(async () => ({ deleted: true }));
const revokeCredentialGrant = mock(async () => ({ grant: null }));
const getProjects = mock(async (machine?: string | null): Promise<Project[]> => [
  {
    id: machine === "leaf-node" ? "leaf-project" : "command-project",
    name: machine === "leaf-node" ? "Leaf project" : "Command project",
  } as Project,
]);
const getEnvironmentSnapshot = mock(
  async (_id: string, machine?: string | null) =>
    ({
      id: "env-1",
      name: machine === "leaf-node" ? "Leaf environment" : "Command environment",
    }) as Environment,
);
const replaceCredentialConnectionValue = mock(async (_input: unknown, _machine?: unknown) =>
  connection(),
);

mock.module("@/lib/backend", () => ({
  ...realBackend,
  getCredentialOverview,
  createCredentialConnection,
  deleteCredentialConnection,
  revokeCredentialGrant,
  getProjects,
  getEnvironmentSnapshot,
  replaceCredentialConnectionValue,
}));

const { CredentialsSettings } = await import("./CredentialsSettings");

afterEach(() => {
  cleanup();
  resetResourceSync();
  resetOverview();
  createCredentialConnection.mockClear();
  deleteCredentialConnection.mockClear();
  revokeCredentialGrant.mockClear();
  replaceCredentialConnectionValue.mockClear();
});

afterAll(() => {
  mock.module("@/lib/backend", () => realBackend);
});

describe("CredentialsSettings", () => {
  test("lists saved credentials, where they are kept and active grants, never a value", async () => {
    renderInAppCommandScope(<CredentialsSettings />);
    const [row] = await screen.findAllByTestId("credential-connection-row");
    expect(row!.textContent).toContain("npm");
    expect(row!.textContent).toContain("Every project");
    expect(row!.textContent).toContain("HTTPS to registry.npmjs.org");
    expect(row!.textContent).toContain("System keychain");
    expect(screen.getByTestId("credential-vault-status").textContent).toContain("keychain");
    const [grantRow] = screen.getAllByTestId("credential-grant-row");
    expect(grantRow!.textContent).toContain("Deploy token");
    expect(grantRow!.textContent).toContain("Temporary value");
    expect(grantRow!.textContent).toContain("used 2 times");
  });

  test("adds a credential with its exact value and policy", async () => {
    renderInAppCommandScope(<CredentialsSettings />);
    await screen.findAllByTestId("credential-connection-row");
    fireEvent.click(screen.getByRole("button", { name: /Add credential/u }));
    const dialog = await screen.findByRole("dialog");
    const [name] = within(dialog).getAllByRole("textbox");
    fireEvent.change(name!, { target: { value: "GitHub" } });
    fireEvent.change(within(dialog).getByLabelText("Credential value"), {
      target: { value: " ghp-value-1234 " },
    });
    fireEvent.change(within(dialog).getByPlaceholderText("api.example.com"), {
      target: { value: "api.github.com" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(createCredentialConnection).toHaveBeenCalledTimes(1));
    expect(createCredentialConnection.mock.calls[0]?.[0]).toEqual({
      name: "GitHub",
      value: " ghp-value-1234 ",
      projectIds: null,
      httpHosts: ["api.github.com"],
    });
  });

  test("revokes a grant and deletes a credential after confirming", async () => {
    renderInAppCommandScope(<CredentialsSettings />);
    await screen.findAllByTestId("credential-grant-row");
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(revokeCredentialGrant).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Delete npm" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteCredentialConnection).toHaveBeenCalledTimes(1));
  });

  test("without a keychain or file store, adding is unavailable", async () => {
    overview = {
      ...overview,
      vault: { durable: "memory", canSave: false, detail: "Values cannot be saved." },
    };
    renderInAppCommandScope(<CredentialsSettings />);
    await screen.findByTestId("credential-vault-status");
    const add = screen.getByRole("button", { name: /Add credential/u }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
  });
});

test("refreshes the Revoke control while the last use is still running", async () => {
  overview = { ...overview, grants: [] };
  const { scope } = renderInAppCommandScope(<CredentialsSettings />);
  await screen.findByText("No agent holds a credential grant.");
  overview = {
    ...overview,
    grants: [{ ...grant, uses: 1, maxUses: 1 }],
    operations: [
      {
        id: "run",
        grantId: grant.id,
        environmentId: grant.environmentId,
        tabId: grant.tabId,
        kind: "command",
        state: "running",
        summary: "Read fixture",
        createdAt: 2,
        cleanup: "none",
      },
    ],
  };
  dispatchResourceChange({ resource: "credential", id: grant.environmentId, revision: 1 }, scope);
  await screen.findByText(/used 1 of 1 time/u);
  const revoke = screen.getByRole("button", { name: "Revoke" });
  overview = { ...overview, grants: [] };
  fireEvent.click(revoke);
  await waitFor(() => expect(revokeCredentialGrant).toHaveBeenCalledTimes(1));
  await screen.findByText("No agent holds a credential grant.");
});

test("loads the selected machine's projects and labels and writes its chosen policy", async () => {
  const mount = (machine: string | null) =>
    renderInAppCommandScope(
      <AccountMachineProvider value={{ machine, name: machine }}>
        <CredentialsSettings />
      </AccountMachineProvider>,
    );
  for (const [machine, project, other, environment, projectId] of [
    [null, "Command project", "Leaf project", "Command environment", "command-project"],
    ["leaf-node", "Leaf project", "Command project", "Leaf environment", "leaf-project"],
  ] as const) {
    const form = mount(machine);
    await screen.findByText(new RegExp(environment, "u"));
    fireEvent.click(screen.getByRole("button", { name: /Add credential/u }));
    const dialog = await screen.findByRole("dialog");
    const [name] = within(dialog).getAllByRole("textbox");
    fireEvent.change(name!, { target: { value: "Fixture" } });
    const value = "  fixture\r\nmore\n  ";
    fireEvent.paste(within(dialog).getByLabelText("Credential value", { exact: true }), {
      clipboardData: { getData: () => value },
    });
    fireEvent.click(
      within(dialog).getByRole("checkbox", { name: "Every project on this machine" }),
    );
    expect(within(dialog).queryByLabelText(other)).toBeFalsy();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: project }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(createCredentialConnection).toHaveBeenLastCalledWith(
        { name: "Fixture", value, projectIds: [projectId], httpHosts: [] },
        machine ?? undefined,
      ),
    );
    form.unmount();
  }
});

test("replaces a value with exact multiline clipboard bytes", async () => {
  renderInAppCommandScope(<CredentialsSettings />);
  fireEvent.click(await screen.findByRole("button", { name: "Replace the value of npm" }));
  const dialog = await screen.findByRole("dialog");
  const value = "fixture\nsecond line";
  fireEvent.paste(within(dialog).getByLabelText("Credential value", { exact: true }), {
    clipboardData: { getData: () => value },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Replace" }));
  await waitFor(() =>
    expect(replaceCredentialConnectionValue).toHaveBeenCalledWith(
      { id: "connection-1", value },
      undefined,
    ),
  );
});
