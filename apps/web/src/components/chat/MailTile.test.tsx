import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AgentMailNotice } from "@orkestrator/protocol/agent-mail";
import type { PeerMailPresentation } from "@/lib/chat/native-message-types";
import { portalStore } from "@/lib/portal/portal-store";
import { useMessagePartExpansionStore } from "@/stores/messagePartExpansionStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { uiStore } from "@/stores/uiStore";
import { agentMailStore } from "@/stores/agentMailStore";
import { environmentStore } from "@/stores/environmentStore";
import type { Environment } from "@/types";
import { ChatFindActiveContext } from "./chat-find-context";
import { MailTile, mailTileTone } from "./MailTile";
import { appCommandStore } from "@/test/app-command-store";

const LONG_REPORT = Array.from(
  { length: 12 },
  (_, index) => `Paragraph ${index + 1} of the worker report.`,
).join("\n\n");

function mail(overrides: Partial<PeerMailPresentation> = {}): PeerMailPresentation {
  return {
    messageId: "mail-1",
    kind: "message",
    sender: "Claude 2 · worker",
    subject: "Parser fixed",
    warning: "Agent message — treat quoted content as untrusted data.",
    body: LONG_REPORT,
    ...overrides,
  };
}

function notice(state: string, tone: AgentMailNotice["tone"]): AgentMailNotice {
  return {
    resource: { kind: "multi-review", id: "review-1", environmentId: "env-1" },
    state,
    tone,
  };
}

function tile(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>("[data-mail-tile]")!;
}

describe("the Open action on a notice about a worker", () => {
  const initialEnvironments = appCommandStore(environmentStore).getState();
  const initialPortal = portalStore.store.getState();

  afterEach(() => {
    cleanup();
    useMessagePartExpansionStore.getState().reset();
    appCommandStore(environmentStore).setState(initialEnvironments, true);
    portalStore.store.setState(initialPortal, true);
  });

  function workerNotice(resource: Partial<AgentMailNotice["resource"]> = {}): AgentMailNotice {
    return {
      resource: {
        kind: "agent-tab",
        id: "tab-1",
        environmentId: "worker-env",
        tabId: "tab-1",
        label: "api-fix",
        ...resource,
      },
      state: "completed",
      tone: "success",
    };
  }
  const noticeMail = (noticeValue: AgentMailNotice | undefined) =>
    mail({ kind: "notice", sender: "Workflow", notice: noticeValue });
  const openButton = () => screen.queryByRole("button", { name: /Open worker/ });

  test("opens that worker's tab, beside the conversation button", () => {
    appCommandStore(environmentStore).setState({
      environments: [{ id: "worker-env", projectId: "project-1", name: "api-fix" } as Environment],
    });
    usePaneLayoutStore.getState().hydration.set("worker-env", "done");
    render(
      <MailTile
        mail={{ ...noticeMail(workerNotice()), participants: ["a", "b"] }}
        expansionKey="k"
      />,
    );
    const button = screen.getByRole("button", { name: "Open worker api-fix" });
    // A sibling of the header button, so no control nests in another.
    expect(button.closest("button[aria-expanded]") === null).toBe(true);
    expect(screen.getByRole("button", { name: "Open conversation" })).toBeTruthy();
    fireEvent.click(button);
    expect(appCommandStore(uiStore).getState().selectedEnvironmentId).toBe("worker-env");
    expect(appCommandStore(uiStore).getState().selectedProjectId).toBe("project-1");
  });

  test("opening does not expand the tile", () => {
    appCommandStore(environmentStore).setState({
      environments: [{ id: "worker-env", projectId: "project-1" } as Environment],
    });
    const { container } = render(<MailTile mail={noticeMail(workerNotice())} expansionKey="k" />);
    fireEvent.click(openButton()!);
    expect(tile(container).dataset.expanded).toBe("false");
  });

  test("an environment notice opens the environment, with no tab to aim for", () => {
    appCommandStore(environmentStore).setState({
      environments: [{ id: "worker-env", projectId: "project-1" } as Environment],
    });
    render(
      <MailTile
        mail={noticeMail({
          resource: { kind: "environment", id: "worker-env", label: "api-fix" },
          state: "pr-merged",
          tone: "success",
        })}
        expansionKey="k"
      />,
    );
    fireEvent.click(openButton()!);
    expect(appCommandStore(uiStore).getState().selectedEnvironmentId).toBe("worker-env");
  });

  test("a worker on another node opens through that node", () => {
    portalStore.store.setState({
      nodes: [
        {
          nodeId: "bk_leaf",
          available: true,
          environments: [
            {
              ref: { backendId: "bk_leaf", environmentId: "worker-env" },
              projectId: "leaf-project",
              deleting: false,
            },
          ],
        },
      ] as never,
    });
    render(<MailTile mail={noticeMail(workerNotice({ nodeId: "bk_leaf" }))} expansionKey="k" />);
    expect(openButton()).toBeTruthy();
  });

  test("a notice with no worker it can reach offers no Open", () => {
    // An environment this client does not know: deleted, or an older notice
    // about another node's worker that names no node.
    const unknown = render(<MailTile mail={noticeMail(workerNotice())} expansionKey="a" />);
    expect(openButton()).toBeNull();
    unknown.unmount();

    // A node this client has no link to.
    const noNode = render(
      <MailTile mail={noticeMail(workerNotice({ nodeId: "bk_gone" }))} expansionKey="b" />,
    );
    expect(openButton()).toBeNull();
    noNode.unmount();

    // A notice about something else, even in a known environment.
    appCommandStore(environmentStore).setState({
      environments: [{ id: "env-1", projectId: "project-1" } as Environment],
    });
    const other = render(
      <MailTile mail={noticeMail(notice("completed", "success"))} expansionKey="c" />,
    );
    expect(openButton()).toBeNull();
    other.unmount();

    // No structured facts at all.
    const bare = render(<MailTile mail={noticeMail(undefined)} expansionKey="d" />);
    expect(openButton()).toBeNull();
    bare.unmount();

    // Mail that is not a notice never has one, whatever it carries.
    appCommandStore(environmentStore).setState({
      environments: [{ id: "worker-env", projectId: "project-1" } as Environment],
    });
    render(<MailTile mail={mail({ notice: workerNotice() })} expansionKey="e" />);
    expect(openButton()).toBeNull();
  });
});

describe("MailTile", () => {
  const initialMail = appCommandStore(agentMailStore).getState();
  const initialEnvironments = appCommandStore(environmentStore).getState();

  afterEach(() => {
    cleanup();
    useMessagePartExpansionStore.getState().reset();
    appCommandStore(agentMailStore).setState(initialMail, true);
    appCommandStore(environmentStore).setState(initialEnvironments, true);
  });

  test("shows attached images by name and size, collapsed and open, without a path", () => {
    const { container } = render(
      <MailTile
        mail={mail({
          attachments: [{ name: "shot.png", bytes: 2048 }, { name: "second.png" }],
        })}
        expansionKey="k"
      />,
    );
    const list = screen.getByRole("list", { name: "Attached images" });
    expect(list.textContent).toContain("shot.png");
    expect(list.textContent).toContain("2.0 KiB");
    expect(list.textContent).toContain("second.png");
    expect(container.querySelectorAll("[data-mail-attachment]")).toHaveLength(2);
    // Outside the clamped body, so a long message cannot clip it away.
    expect(container.querySelector("[data-mail-body] [data-mail-attachments]") === null).toBe(true);
    expect(container.textContent).not.toContain("mail-attachments/");

    fireEvent.click(screen.getByRole("button", { name: /Claude 2 · worker/ }));
    expect(screen.getByRole("list", { name: "Attached images" })).toBeTruthy();
  });

  test("a message with no images draws no attachment row", () => {
    const { container } = render(<MailTile mail={mail()} expansionKey="k" />);
    expect(container.querySelector("[data-mail-attachments]") === null).toBe(true);
  });

  test("starts collapsed with the body clamped to a few lines", () => {
    const { container } = render(
      <MailTile mail={mail()} expansionKey="k" timestampLabel="10:04" />,
    );

    const button = screen.getByRole("button", { name: /Claude 2 · worker/ });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(tile(container).dataset.expanded).toBe("false");
    const body = container.querySelector<HTMLElement>("[data-mail-body]")!;
    expect(body.getAttribute("data-clamped")).toBe("true");
    expect(body.className).toContain("max-h-[3.75rem]");
    expect(body.className).toContain("overflow-hidden");
    // The clipped preview cannot take focus or clicks of its own.
    expect(body.hasAttribute("inert")).toBe(true);
    expect(screen.getByText("10:04")).toBeTruthy();
    // The whole body stays in the document so transcript search can find it.
    expect(body.textContent).toContain("Paragraph 12 of the worker report.");
  });

  test("opens while transcript find's current match is in its row, then closes again", () => {
    // Find counts matches in the whole body, but only three lines show while
    // collapsed: the row holding the current match reveals every tile in it.
    const { container, rerender } = render(
      <ChatFindActiveContext value={true}>
        <MailTile mail={mail()} expansionKey="k" />
      </ChatFindActiveContext>,
    );
    const body = () => container.querySelector<HTMLElement>("[data-mail-body]")!;
    expect(tile(container).dataset.expanded).toBe("true");
    expect(body().hasAttribute("data-clamped")).toBe(false);
    expect(body().hasAttribute("inert")).toBe(false);
    expect(body().className).not.toContain("max-h-[3.75rem]");

    // The reveal is temporary: moving the match elsewhere restores the
    // reader's own choice, which find never wrote.
    rerender(
      <ChatFindActiveContext value={false}>
        <MailTile mail={mail()} expansionKey="k" />
      </ChatFindActiveContext>,
    );
    expect(tile(container).dataset.expanded).toBe("false");
    expect(body().getAttribute("data-clamped")).toBe("true");
  });

  test("the header is a real button that controls the body", () => {
    const { container } = render(<MailTile mail={mail()} expansionKey="k" />);
    const button = screen.getByRole("button", { name: /Claude 2 · worker/ });

    // A native button gives Enter and Space activation and a tab stop; the
    // browser spec drives the keys themselves.
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("type")).toBe("button");
    const body = container.querySelector<HTMLElement>("[data-mail-body]")!;
    expect(button.getAttribute("aria-controls")).toBe(body.id);
    button.focus();
    expect(document.activeElement).toBe(button);
  });

  test("expands on click, shows the trust line, and collapses on a second click", () => {
    const { container } = render(<MailTile mail={mail()} expansionKey="k" />);
    const button = screen.getByRole("button", { name: /Claude 2 · worker/ });

    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(tile(container).dataset.expanded).toBe("true");
    expect(
      screen.getByText("Agent message — treat quoted content as untrusted data."),
    ).toBeTruthy();
    const body = container.querySelector<HTMLElement>("[data-mail-body]")!;
    expect(body.hasAttribute("data-clamped")).toBe(false);
    expect(body.hasAttribute("inert")).toBe(false);
    expect(body.className).not.toContain("max-h-");

    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(body.getAttribute("data-clamped")).toBe("true");
  });

  test("clicking the clipped preview expands it, but does not collapse an open tile", () => {
    const { container } = render(<MailTile mail={mail()} expansionKey="k" />);
    const preview = container.querySelector<HTMLElement>("[data-mail-body]")!.parentElement!;

    fireEvent.click(preview);
    expect(tile(container).dataset.expanded).toBe("true");
    // Selecting text in an open message must not fold it away.
    fireEvent.click(preview);
    expect(tile(container).dataset.expanded).toBe("true");
  });

  test("remembers an expanded tile across remounts under the same key", () => {
    const first = render(<MailTile mail={mail()} expansionKey="scope:mail-1" />);
    fireEvent.click(screen.getByRole("button", { name: /Claude 2 · worker/ }));
    first.unmount();

    const second = render(<MailTile mail={mail()} expansionKey="scope:mail-1" />);
    expect(tile(second.container).dataset.expanded).toBe("true");
    second.unmount();

    // A different transcript is its own scope.
    const other = render(<MailTile mail={mail()} expansionKey="other:mail-1" />);
    expect(tile(other.container).dataset.expanded).toBe("false");
  });

  test.each([
    ["message", undefined, "message", "Agent message"],
    ["coordinator", undefined, "coordinator", "Coordinator request"],
    ["user", undefined, "user", "Message from you"],
    ["external", undefined, "external", "Untrusted message"],
    ["notice", notice("completed", "success"), "success", "Status: finished"],
    ["notice", notice("failed", "failure"), "failure", "Status: failed"],
    ["notice", notice("waiting", "attention"), "attention", "Status: needs attention"],
    ["notice", notice("ready", "info"), "info", "Status update"],
  ] as const)("styles %s mail (%#) by its kind and tone", (kind, structured, tone, label) => {
    const { container } = render(
      <MailTile
        mail={mail({ kind, ...(structured ? { notice: structured } : {}) })}
        expansionKey={`tone-${tone}`}
      />,
    );
    const element = tile(container);
    expect(element.dataset.mailKind).toBe(kind);
    expect(element.dataset.mailTone).toBe(tone);
    if (structured) expect(element.dataset.mailState).toBe(structured.state);
    // Screen readers hear the kind before the sender.
    expect(screen.getByRole("button").textContent).toContain(label);
  });

  test("tells notices apart from peer mail at a glance", () => {
    const worker = render(<MailTile mail={mail()} expansionKey="a" />);
    const workerFrame = tile(worker.container).firstElementChild!.className;
    const workerIcon = tile(worker.container).querySelector("svg")!.getAttribute("class");
    worker.unmount();

    const failed = render(
      <MailTile
        mail={mail({ kind: "notice", notice: notice("failed", "failure") })}
        expansionKey="b"
      />,
    );
    expect(tile(failed.container).firstElementChild!.className).not.toBe(workerFrame);
    expect(tile(failed.container).querySelector("svg")!.getAttribute("class")).not.toBe(workerIcon);
    expect(tile(failed.container).firstElementChild!.className).toContain("red");
  });

  test("a notice without structured facts reads as neutral news", () => {
    expect(mailTileTone({ kind: "notice" })).toBe("info");
    const { container } = render(
      <MailTile mail={mail({ kind: "notice" })} expansionKey="legacy" />,
    );
    expect(tile(container).dataset.mailTone).toBe("info");
    expect(tile(container).querySelector("svg")!.getAttribute("class")).toContain("lucide-bell");
  });

  test("lays out for narrow widths without fixed sizes", () => {
    const { container } = render(
      <MailTile
        mail={mail({
          sender: "A very long worker name that would never fit on a phone",
          subject: "An equally long subject line describing the whole report in detail",
        })}
        expansionKey="mobile"
      />,
    );
    const button = screen.getByRole("button");
    // Sender and subject stack on narrow containers and sit inline from `@sm`.
    const labels = button.querySelector("span.flex-col")!;
    expect(labels.className).toContain("min-w-0");
    expect(labels.className).toContain("@sm:flex-row");
    for (const text of labels.querySelectorAll("span")) {
      expect(text.className).toContain("truncate");
    }
    expect(tile(container).innerHTML).not.toMatch(/\bw-\[\d+px\]/);
    expect(tile(container).firstElementChild!.className).toContain("min-w-0");
  });

  test("draws mail this agent sent with its delivery state", () => {
    const { container } = render(
      <MailTile
        mail={mail({
          direction: "out",
          sender: "To Codex 2",
          status: { label: "waiting to deliver", tone: "progress" },
        })}
        expansionKey="sent"
      />,
    );
    expect(tile(container).dataset.mailTone).toBe("sent");
    expect(screen.getByText("To Codex 2")).toBeTruthy();
    expect(screen.getByText("waiting to deliver").dataset.mailStatus).toBe("progress");
    expect(mailTileTone({ kind: "message", direction: "out" })).toBe("sent");
  });

  test("names a recipient tab with its environment, giving way on the environment first", () => {
    appCommandStore(environmentStore).setState({ environments: [] });
    const { container } = render(
      <MailTile
        mail={mail({
          direction: "out",
          sender: "To env-1 · Claude 2",
          address: { environmentId: "env-1", tabId: "tab-1", tabName: "Claude 2" },
          status: { label: "delivered", tone: "muted" },
        })}
        expansionKey="named"
      />,
    );
    const sender = tile(container).querySelector<HTMLElement>("[data-mail-sender]")!;
    expect(sender.textContent).toBe("To env-1 · Claude 2");
    act(() =>
      appCommandStore(environmentStore).setState({
        environments: [
          {
            id: "env-1",
            name: "a-very-long-environment-name-for-the-login-fix",
            order: 0,
          } as Environment,
        ],
      }),
    );
    expect(sender.textContent).toBe("To a-very-long-environment-name-for-the-login-fix · Claude 2");
    expect(sender.title).toBe(sender.textContent);
    // Only the environment's name truncates; the tab, status and chevron keep their room.
    const [prefix, environment, rest] = Array.from(sender.children) as HTMLElement[];
    expect(prefix!.className).toContain("shrink-0");
    expect(environment!.className).toContain("truncate");
    expect(environment!.className).toContain("min-w-0");
    expect(rest!.className).toContain("shrink-0");
    expect(rest!.className).toContain("text-ellipsis");
    expect(sender.className).toContain("min-w-0");
    expect(screen.getByText("delivered").className).toContain("shrink-0");
  });

  test.each(["Claude 2", undefined])(
    "updates a received sender's environment name with tab %s",
    (tabName) => {
      appCommandStore(environmentStore).setState({ environments: [] });
      appCommandStore(agentMailStore).setState({ mailboxes: new Map() });
      const environmentId = "acf90d0f-8be8-45ba-b87b-745b54a007e0";
      const { container } = render(
        <MailTile
          mail={mail({
            sender: `acf90d0f · ${tabName ?? "startup-agent"}`,
            address: { environmentId, tabId: "startup-agent", tabName },
          })}
          expansionKey="received"
        />,
      );
      const sender = tile(container).querySelector<HTMLElement>("[data-mail-sender]")!;
      expect(sender.textContent).toBe(`acf90d0f · ${tabName ?? "startup-agent"}`);
      act(() =>
        appCommandStore(environmentStore).setState({
          environments: [{ id: environmentId, name: "worker", order: 0 } as Environment],
        }),
      );
      expect(sender.textContent).toBe(`worker · ${tabName ?? "startup-agent"}`);
      expect(sender.title).toBe(sender.textContent);
      expect(sender.textContent).not.toContain("To ");
    },
  );

  test("renders a received environment-only address without a tab suffix", () => {
    appCommandStore(environmentStore).setState({
      environments: [{ id: "env-1", name: "worker", order: 0 } as Environment],
    });
    const { container } = render(
      <MailTile
        mail={mail({
          sender: "env-1 · worker",
          address: { environmentId: "env-1", tabId: "startup-agent", tabName: "worker" },
        })}
        expansionKey="environment-only"
      />,
    );
    const sender = tile(container).querySelector<HTMLElement>("[data-mail-sender]")!;
    expect(sender.textContent).toBe("worker");
    expect(sender.title).toBe("worker");
    expect(sender.children).toHaveLength(1);
    expect(sender.firstElementChild!.className).toContain("truncate");
  });

  test("opens the conversation between sender and recipient", () => {
    appCommandStore(agentMailStore).setState({ panel: null });
    render(
      <MailTile mail={mail({ participants: ["env-2\0tab-2", "env-1\0tab-1"] })} expansionKey="c" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open conversation" }));
    expect(appCommandStore(agentMailStore).getState().panel).toEqual({
      conversation: ["env-2\0tab-2", "env-1\0tab-1"],
    });
    appCommandStore(agentMailStore).setState({ panel: null });
  });

  test("offers no conversation without both participants", () => {
    render(<MailTile mail={mail()} expansionKey="none" />);
    expect(screen.queryByRole("button", { name: "Open conversation" }) === null).toBe(true);
  });
});
