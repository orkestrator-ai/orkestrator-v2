import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { invoke } from "@/lib/native/backend";
import type { PreviousSession } from "@/lib/claude-tmux-client";
import { ResumeTmuxSessionDialog } from "./ResumeTmuxSessionDialog";

const invokeMock = invoke as unknown as ReturnType<typeof mock>;

function deferredSessions() {
  let resolve!: (sessions: PreviousSession[]) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<PreviousSession[]>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function session(title: string): PreviousSession {
  return {
    session_id: title,
    title,
    last_activity_unix: 1_790_000_000,
    message_count: 2,
    transcript_path: `/synthetic/${title}.jsonl`,
  };
}

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve());
});

describe("ResumeTmuxSessionDialog request ownership", () => {
  for (const change of ["environment", "reopen"] as const) {
    for (const outcome of ["success", "error"] as const) {
      for (const order of ["old-first", "current-first"] as const) {
        test(`ignores stale ${outcome} after ${change} (${order})`, async () => {
          const old = deferredSessions();
          const current = deferredSessions();
          invokeMock.mockImplementationOnce(() => old.promise);
          invokeMock.mockImplementationOnce(() => current.promise);
          const onResume = mock(() => {});
          const props = { open: true, environmentId: "env-a", onOpenChange: () => {}, onResume };
          const { rerender } = render(<ResumeTmuxSessionDialog {...props} />);
          if (change === "reopen") rerender(<ResumeTmuxSessionDialog {...props} open={false} />);
          rerender(
            <ResumeTmuxSessionDialog
              {...props}
              environmentId={change === "environment" ? "env-b" : "env-a"}
            />,
          );

          const settleOld = async () => {
            await act(async () => {
              if (outcome === "error") old.reject(new Error("stale failure"));
              else old.resolve([session("Stale session")]);
              await old.promise.catch(() => {});
            });
          };
          const settleCurrent = async () => {
            await act(async () => {
              current.resolve([session("Current session")]);
            });
          };

          if (order === "old-first") {
            await settleOld();
            expect(screen.queryByText("Stale session") === null).toBe(true);
            expect(screen.queryByText(/stale failure/) === null).toBe(true);
            expect(screen.queryByText(/No previous sessions/) === null).toBe(true);
            expect(document.querySelector(".animate-spin") !== null).toBe(true);
            await settleCurrent();
          } else {
            await settleCurrent();
            await settleOld();
          }
          expect(screen.getByText("Current session")).toBeTruthy();
          expect(screen.queryByText("Stale session") === null).toBe(true);
          expect(screen.queryByText(/stale failure/) === null).toBe(true);
          expect(document.querySelector(".animate-spin") === null).toBe(true);
          fireEvent.click(screen.getByText("Current session"));
          expect(onResume).toHaveBeenCalledWith("Current session");
          expect(invokeMock).toHaveBeenLastCalledWith("claude_tmux_list_previous_sessions", {
            environmentId: change === "environment" ? "env-b" : "env-a",
          });
        });
      }
    }
  }
});
