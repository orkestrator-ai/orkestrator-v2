import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type {
  CredentialConnection,
  CredentialGrantRecord,
  CredentialOverview,
} from "@orkestrator/protocol/agent-credentials";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
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

mock.module("@/lib/backend", () => ({
  ...realBackend,
  getCredentialOverview,
  createCredentialConnection,
  deleteCredentialConnection,
  revokeCredentialGrant,
}));

const { CredentialsSettings } = await import("./CredentialsSettings");

afterEach(() => {
  cleanup();
  resetOverview();
  createCredentialConnection.mockClear();
  deleteCredentialConnection.mockClear();
  revokeCredentialGrant.mockClear();
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
