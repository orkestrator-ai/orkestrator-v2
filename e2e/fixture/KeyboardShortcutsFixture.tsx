import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { designBootstrap } from "@orkestrator/protocol/design-runtime";
import { DesignFrameBridge } from "@/components/design/frame-bridge";
import { KeyboardShortcutsDialog } from "@/components/layout/KeyboardShortcutsDialog";
import { onAppShortcut, requestAppShortcut } from "@/lib/app-shortcuts";
import {
  isWorkspaceRealm,
  parseRealmMessage,
  readFrameEnvelope,
} from "@/lib/federation/workspace-realm";

/** Stands in for the sidebar search: counts the ⌘K requests this window handles. */
function SearchRequests() {
  const [count, setCount] = useState(0);
  useEffect(() => onAppShortcut("search-projects", () => setCount((value) => value + 1)), []);
  return <output data-testid="search-requests">{count}</output>;
}

/**
 * A same-origin workspace realm frame, as the browser client embeds another
 * node's workspace; its window side relays app shortcuts as
 * `RemoteWorkspaceRegion` does.
 */
function RealmFrame() {
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.source !== frame.current?.contentWindow) return;
      const envelope = readFrameEnvelope(event.data);
      const message =
        envelope?.workspaceId === "fixture" ? parseRealmMessage(envelope.message) : null;
      if (message?.type === "shortcut") requestAppShortcut(message.shortcut);
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, []);
  return (
    <iframe
      ref={frame}
      title="Workspace realm"
      src="/keyboard-shortcuts?realm=workspace&workspace=fixture"
    />
  );
}

/** The realm document: its own composer and shortcuts dialog, no search. */
function RealmFixture() {
  return (
    <main>
      <textarea aria-label="Realm composer" />
      <KeyboardShortcutsDialog platform="mac" />
    </main>
  );
}

export function KeyboardShortcutsFixture() {
  return isWorkspaceRealm() ? <RealmFixture /> : <WindowFixture />;
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
          designBridge.current = new DesignFrameBridge(target);
          void designBridge.current
            .ask({
              op: "render",
              html: '<input aria-label="Design input">',
            })
            .catch(() => undefined);
        }}
      />
      <iframe title="Service preview" sandbox="allow-scripts" />
      <RealmFrame />
      <SearchRequests />
      <KeyboardShortcutsDialog platform="mac" />
    </main>
  );
}
