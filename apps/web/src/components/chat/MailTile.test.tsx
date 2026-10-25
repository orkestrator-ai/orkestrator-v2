import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AgentMailNotice } from "@orkestrator/protocol/agent-mail";
import type { PeerMailPresentation } from "@/lib/chat/native-message-types";
import { useMessagePartExpansionStore } from "@/stores/messagePartExpansionStore";
import { useAgentMailStore } from "@/stores/agentMailStore";
import { MailTile, mailTileTone } from "./MailTile";

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

describe("MailTile", () => {
  afterEach(() => {
    cleanup();
    useMessagePartExpansionStore.getState().reset();
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

  test("opens the conversation between sender and recipient", () => {
    useAgentMailStore.setState({ panel: null });
    render(
      <MailTile mail={mail({ participants: ["env-2\0tab-2", "env-1\0tab-1"] })} expansionKey="c" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open conversation" }));
    expect(useAgentMailStore.getState().panel).toEqual({
      conversation: ["env-2\0tab-2", "env-1\0tab-1"],
    });
    useAgentMailStore.setState({ panel: null });
  });

  test("offers no conversation without both participants", () => {
    render(<MailTile mail={mail()} expansionKey="none" />);
    expect(screen.queryByRole("button", { name: "Open conversation" }) === null).toBe(true);
  });
});
