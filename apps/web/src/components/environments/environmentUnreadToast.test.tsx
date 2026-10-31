import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import type { Environment } from "@/types";
import { mockToast, resetSonnerMocks } from "../../../../../tests/mocks/sonner";
import { describeUnreadReason, showEnvironmentUnreadToast } from "./environmentUnreadToast";

function environment(overrides: Partial<Environment> = {}): Environment {
  return {
    id: "env-1",
    projectId: "project-1",
    name: "Review",
    status: "running",
    hasUnreadWork: true,
    ...overrides,
  } as Environment;
}

type ToastOptions = { id: string; description: string; icon: ReactElement; position: string };

function lastToast(): { title: unknown; options: ToastOptions } {
  const call = mockToast.mock.calls.at(-1);
  if (!call) throw new Error("toast was not shown");
  return { title: call[0], options: call[1] as ToastOptions };
}

afterEach(() => {
  cleanup();
  resetSonnerMocks();
});

describe("showEnvironmentUnreadToast", () => {
  test("names what lit the bell, in the top right, keyed to the environment", () => {
    showEnvironmentUnreadToast(
      environment({ unreadReason: "agent_question", agentActivityState: "working" }),
    );

    const { title, options } = lastToast();
    expect(title).toBe("Agent asked a question");
    expect(options).toMatchObject({
      id: "environment-unread:env-1",
      description: "Review: The agent asked a question for you to answer.",
      position: "top-right",
    });
  });

  test("composer readiness explains that background work is continuing", () => {
    showEnvironmentUnreadToast(
      environment({ unreadReason: "agent_ready", agentActivityState: "working" }),
    );

    expect(lastToast().title).toBe("Agent ready for input");
    expect(lastToast().options.description).toBe(
      "Review: You can send another message while background work continues.",
    );
  });

  test("a failed turn is not announced as completed work", () => {
    showEnvironmentUnreadToast(environment({ unreadReason: "agent_failed" }));

    expect(lastToast().title).toBe("Agent stopped with an error");
    expect(lastToast().options.description).toBe(
      "Review: The agent's turn failed before it finished. Open the tab to see the error.",
    );
  });

  test("shows the same amber bell as the environment list", () => {
    showEnvironmentUnreadToast(environment({ unreadReason: "agent_finished" }));

    const { container } = render(lastToast().options.icon);
    const icon = container.querySelector("svg");
    expect(icon?.classList.contains("text-amber-400")).toBe(true);
    expect(icon?.classList.contains("fill-amber-400/20")).toBe(true);
  });

  test("labels the hidden project home the way the sidebar does", () => {
    showEnvironmentUnreadToast(
      environment({ name: "project-home", projectHome: true, unreadReason: "agent_waiting" }),
    );

    expect(lastToast().options.description).toStartWith("Project home: ");
  });

  test("falls back to generic copy for badges without a recorded reason", () => {
    showEnvironmentUnreadToast(environment());

    expect(lastToast().title).toBe("New activity");
  });
});

describe("describeUnreadReason", () => {
  test("gives every reason its own title", () => {
    const titles = (
      [
        "agent_finished",
        "agent_failed",
        "agent_ready",
        "agent_waiting",
        "agent_question",
        "terminal_finished",
        "marked_unread",
      ] as const
    ).map((reason) => describeUnreadReason(reason).title);
    expect(new Set(titles).size).toBe(titles.length);
    expect(titles).not.toContain(describeUnreadReason(undefined).title);
  });
});
