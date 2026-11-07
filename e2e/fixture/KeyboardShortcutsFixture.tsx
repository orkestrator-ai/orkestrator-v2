import { ProjectSearchBar } from "@/components/sidebar/ProjectSearchBar";
import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { designBootstrap } from "@orkestrator/protocol/design-runtime";
import { DesignFrameBridge } from "@/components/design/frame-bridge";
import { KeyboardShortcutsDialog } from "@/components/layout/KeyboardShortcutsDialog";
import { onAppShortcut, setShownAppShortcutWorkspace } from "@/lib/app-shortcuts";

/** Stands in for the sidebar search: counts the ⌘K requests this window handles. */
function SearchRequests() {
  const [count, setCount] = useState(0);
  useEffect(() => onAppShortcut("search-projects", () => setCount((value) => value + 1)), []);
  return <output data-testid="search-requests">{count}</output>;
}

export function KeyboardShortcutsFixture() {
  return new URLSearchParams(window.location.search).has("in-tree") ? (
    <InTreeFixture />
  ) : (
    <WindowFixture />
  );
}

/** Counts one app shortcut's requests in this document, optionally for one workspace. */
function useShortcutCount(id: Parameters<typeof onAppShortcut>[0], workspace?: object): number {
  const [count, setCount] = useState(0);
  useEffect(
    () => onAppShortcut(id, () => setCount((value) => value + 1), workspace ? { workspace } : {}),
    [id, workspace],
  );
  return count;
}

const COMMAND_WORKSPACE = { node: "command" };
const LEAF_WORKSPACE = { node: "leaf" };

/**
 * A window showing a leaf in its own tree (plan items 4001 and 5003): the
 * leaf's workspace is in this document beside the window's own (hidden, still
 * mounted). The window says which
 * workspace it shows, as `AppShell` does.
 */
function InTreeFixture() {
  const [shown, setShown] = useState<object>(LEAF_WORKSPACE);
  useEffect(() => setShownAppShortcutWorkspace(() => shown), [shown]);
  const search = useShortcutCount("search-projects");
  const settings = useShortcutCount("open-settings");
  const grouping = useShortcutCount("rotate-sidebar-grouping");
  const commandTabs = useShortcutCount("new-agent-tab", COMMAND_WORKSPACE);
  const leafTabs = useShortcutCount("new-agent-tab", LEAF_WORKSPACE);
  const leafShown = shown === LEAF_WORKSPACE;
  return (
    <main>
      <output data-testid="search-requests">{search}</output>
      <output data-testid="settings-requests">{settings}</output>
      <output data-testid="grouping-requests">{grouping}</output>
      <output data-testid="command-new-tabs">{commandTabs}</output>
      <output data-testid="leaf-new-tabs">{leafTabs}</output>
      <button
        type="button"
        onClick={() => setShown(leafShown ? COMMAND_WORKSPACE : LEAF_WORKSPACE)}
      >
        {leafShown ? "Show this machine" : "Show the leaf"}
      </button>
      <section data-testid="command-workspace" hidden={leafShown}>
        <textarea aria-label="Command composer" />
      </section>
      <section data-testid="in-tree-workspace" hidden={!leafShown}>
        <textarea aria-label="Leaf composer" />
      </section>
      <KeyboardShortcutsDialog platform="mac" />
    </main>
  );
}

function WindowFixture() {
  const host = useRef<HTMLDivElement>(null);
  const designBridge = useRef<DesignFrameBridge | null>(null);
  useEffect(() => () => designBridge.current?.close(), []);
  const [input, setInput] = useState("");
  useEffect(() => {
    const terminal = new Terminal({ cols: 40, rows: 4 });
    terminal.open(host.current!);
    const subscription = terminal.onData((data) => setInput((value) => value + data));
    return () => {
      subscription.dispose();
      terminal.dispose();
    };
  }, []);
  return (
    <main>
      <textarea aria-label="Composer" />
      <div ref={host} data-testid="terminal" />
      <output data-testid="terminal-input">{input}</output>
      <iframe
        title="Design preview"
        sandbox="allow-scripts"
        srcDoc={designBootstrap("keyboard-shortcuts-fixture-nonce")}
        onLoad={(event) => {
          designBridge.current?.close();
          const target = event.currentTarget.contentWindow!;
          designBridge.current = new DesignFrameBridge(target).open();
          void designBridge.current
            .ask({
              op: "render",
              html: '<input aria-label="Design input">',
            })
            .catch(() => undefined);
        }}
      />
      <iframe title="Service preview" sandbox="allow-scripts" />
      {new URLSearchParams(window.location.search).has("search-ui") ? (
        <ProjectSearchBar
          projects={[]}
          environments={[]}
          onSelectProject={() => {}}
          onSelectEnvironment={() => {}}
        />
      ) : (
        <SearchRequests />
      )}
      <KeyboardShortcutsDialog platform="mac" />
    </main>
  );
}
