import { afterEach, describe, expect, test } from "bun:test";
import type { BackendId } from "@orkestrator/protocol/federation";
import { act, cleanup, render, screen } from "@testing-library/react";
import { cleanupNodeScopes, FakeNodeClient, renderInNodeScope } from "@/test/render-in-node-scope";
import { resetWindowScopeForTests } from "./app-window-scope";
import {
  CommandNodeScopeProvider,
  NodeScopeProvider,
  useNodeScope,
  useSignal,
  useWindowScope,
  WindowScopeProvider,
} from "./providers";
import { defineScopedStore, useScopedStore } from "./scoped-store";
import { WindowScope } from "./window-scope";

const NODE_A = "bk_node-a" as BackendId;
const NODE_B = "bk_node-b" as BackendId;

interface LabelState {
  label: string;
  setLabel(label: string): void;
}

const labelStore = defineScopedStore<LabelState>("test-label", (scope) => (set) => ({
  label: `label of ${scope.nodeId}`,
  setLabel: (label) => set({ label }),
}));

function Label({ testId }: { testId: string }) {
  const label = useScopedStore(labelStore, (state) => state.label);
  return <span data-testid={testId}>{label}</span>;
}

function NodeIdentity() {
  const scope = useNodeScope();
  const tier = useSignal(scope.tier);
  return (
    <span data-testid="identity">
      {scope.role}:{scope.nodeId}:{tier}
    </span>
  );
}

afterEach(() => {
  cleanupNodeScopes();
  cleanup();
  resetWindowScopeForTests();
});

describe("node scope providers", () => {
  test("useScopedStore reads the nearest provider's instance", () => {
    const client = new FakeNodeClient({ nodeId: NODE_A });
    const { scope } = renderInNodeScope(<Label testId="label" />, { client });
    expect(screen.getByTestId("label").textContent).toBe(`label of ${NODE_A}`);

    act(() => scope.store(labelStore).getState().setLabel("renamed"));
    expect(screen.getByTestId("label").textContent).toBe("renamed");
  });

  test("two subtrees under different node scopes see independent stores", () => {
    const windowScope = new WindowScope();
    const a = windowScope.open({ role: "command", client: new FakeNodeClient({ nodeId: NODE_A }) });
    windowScope.open({ role: "leaf", client: new FakeNodeClient({ nodeId: NODE_B }) });
    render(
      <WindowScopeProvider windowScope={windowScope}>
        <CommandNodeScopeProvider>
          <Label testId="command" />
          <NodeScopeProvider nodeId={NODE_B}>
            <Label testId="leaf" />
          </NodeScopeProvider>
        </CommandNodeScopeProvider>
      </WindowScopeProvider>,
    );
    act(() => a.store(labelStore).getState().setLabel("command only"));
    expect(screen.getByTestId("command").textContent).toBe("command only");
    expect(screen.getByTestId("leaf").textContent).toBe(`label of ${NODE_B}`);
    cleanup();
    windowScope.dispose();
  });

  test("renderInNodeScope supplies a node id and role, and a fake client by default", () => {
    const { client, scope } = renderInNodeScope(<NodeIdentity />, {
      nodeId: NODE_B,
      role: "leaf",
    });
    expect(client).toBeInstanceOf(FakeNodeClient);
    expect(scope.client).toBe(client);
    expect(screen.getByTestId("identity").textContent).toBe(`leaf:${NODE_B}:live`);
    act(() => scope.setTier("warm"));
    expect(screen.getByTestId("identity").textContent).toBe(`leaf:${NODE_B}:warm`);
  });

  test("unmounting a provider does not dispose its scope (invariant 2)", () => {
    const { scope, unmount } = renderInNodeScope(<Label testId="label" />);
    unmount();
    expect(scope.disposed).toBe(false);
    cleanupNodeScopes();
    expect(scope.disposed).toBe(true);
  });

  test("useNodeScope and useWindowScope throw outside a provider in tests", () => {
    function Bare() {
      useNodeScope();
      return null;
    }
    function BareWindow() {
      useWindowScope();
      return null;
    }
    const silence = console.error;
    console.error = () => {};
    try {
      expect(() => render(<Bare />)).toThrow(/needs a NodeScopeProvider/);
      expect(() => render(<BareWindow />)).toThrow(/needs a WindowScopeProvider/);
    } finally {
      console.error = silence;
    }
  });

  test("NodeScopeProvider throws for a node with no open scope", () => {
    const windowScope = new WindowScope();
    const silence = console.error;
    console.error = () => {};
    try {
      expect(() =>
        render(
          <WindowScopeProvider windowScope={windowScope}>
            <NodeScopeProvider nodeId={NODE_B}>
              <Label testId="label" />
            </NodeScopeProvider>
          </WindowScopeProvider>,
        ),
      ).toThrow(/No node scope is open/);
    } finally {
      console.error = silence;
      windowScope.dispose();
    }
  });

  test("the default WindowScopeProvider uses the app window scope and its command scope", () => {
    render(
      <WindowScopeProvider>
        <CommandNodeScopeProvider>
          <NodeIdentity />
        </CommandNodeScopeProvider>
      </WindowScopeProvider>,
    );
    expect(screen.getByTestId("identity").textContent).toMatch(
      /^command:provisional:command-node:live$/,
    );
  });
});
