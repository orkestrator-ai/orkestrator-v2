import { describe, expect, test } from "bun:test";
import type {
  NativeAgentSuborkBatchView,
  NativeAgentSuborkView,
} from "@orkestrator/protocol/suborks";
import {
  finishedCall,
  rowText,
  submitCount,
  targetsInFlight,
  wokenAfterCall,
  type Projection,
  type Row,
} from "./suborks-live-checks";

const TAG = "QATAG0123ABCD";

function subork(agent: "pi" | "opencode", status: NativeAgentSuborkView["status"]) {
  return { id: `s-${agent}`, name: agent, agent, status } as NativeAgentSuborkView;
}

function batch(
  status: NativeAgentSuborkBatchView["status"],
  delivery: NativeAgentSuborkBatchView["delivery"],
  suborks: NativeAgentSuborkView[] = [subork("pi", "finished")],
): NativeAgentSuborkBatchView {
  return { id: "b-1", createdAt: "2026-11-13T00:00:00Z", status, delivery, suborks };
}

function view(phase: string, messages: Row[] = [], suborks: NativeAgentSuborkBatchView[] = []) {
  return { turn: { phase }, messages, suborks } satisfies Projection;
}

describe("finishedCall waits for the call and its delivery", () => {
  test("not while running, nor once settled but not yet mailed", () => {
    expect(finishedCall(view("idle", [], [batch("running", "waiting")]))).toBeUndefined();
    expect(finishedCall(view("idle", [], [batch("settled", "waiting")]))).toBeUndefined();
  });

  test("returns the call once its mail is sent", () => {
    const sequence = [
      batch("running", "waiting"),
      batch("settled", "waiting"),
      batch("settled", "sent"),
    ].map((current) => finishedCall(view("idle", [], [current])));
    expect(sequence.map((current) => current?.delivery)).toEqual([undefined, undefined, "sent"]);
  });

  test("returns a stopped call or a failed delivery, so the spec fails on it", () => {
    expect(finishedCall(view("idle", [], [batch("stopped", "not-needed")]))?.status).toBe(
      "stopped",
    );
    expect(finishedCall(view("idle", [], [batch("settled", "failed")]))?.delivery).toBe("failed");
  });

  test("nothing without a projection", () => {
    expect(finishedCall(null)).toBeUndefined();
    expect(finishedCall(undefined)).toBeUndefined();
  });
});

describe("wokenAfterCall reads the rows, not a change since a sample", () => {
  const request: Row = { role: "user", content: `<orkestrator-subork-request>${TAG}` };
  const handle: Row = { role: "assistant", content: "Asked." };
  const mail: Row = { role: "user", parts: [{ type: "text", text: "<orkestrator-peer-message>" }] };
  const ack: Row = { role: "assistant", parts: [{ type: "text", content: "Thanks." }] };

  test("a wake already over by the first poll counts, and still counts unchanged", () => {
    const settled = view("idle", [request, handle, mail, ack]);
    expect(wokenAfterCall(settled, TAG)).toBe(true);
    expect(wokenAfterCall(settled, TAG)).toBe(true);
  });

  test("not before the mail, nor before the woken turn answers or settles", () => {
    expect(wokenAfterCall(view("idle", [request, handle]), TAG)).toBe(false);
    expect(wokenAfterCall(view("running", [request, handle, mail]), TAG)).toBe(false);
    expect(wokenAfterCall(view("idle", [request, handle, mail]), TAG)).toBe(false);
    expect(wokenAfterCall(view("running", [request, handle, mail, ack]), TAG)).toBe(false);
  });

  test("not for another call's rows", () => {
    expect(wokenAfterCall(view("idle", [request, handle, mail, ack]), "QATAG99999999")).toBe(false);
  });
});

describe("targetsInFlight", () => {
  const running = (suborks: NativeAgentSuborkView[]) =>
    view("idle", [], [batch("running", "waiting", suborks)]);

  test("every named target sent and not over", () => {
    expect(
      targetsInFlight(running([subork("pi", "running"), subork("opencode", "running")]), [
        "opencode",
        "pi",
      ]),
    ).toBeTruthy();
  });

  test("not while a target is still starting, or after one finished", () => {
    expect(targetsInFlight(running([subork("pi", "starting")]), ["pi"])).toBeUndefined();
    expect(
      targetsInFlight(running([subork("pi", "running"), subork("opencode", "finished")]), [
        "pi",
        "opencode",
      ]),
    ).toBeUndefined();
  });

  test("not for a settled call or other targets", () => {
    expect(
      targetsInFlight(view("idle", [], [batch("settled", "sent", [subork("pi", "running")])]), [
        "pi",
      ]),
    ).toBeUndefined();
    expect(targetsInFlight(running([subork("pi", "running")]), ["opencode"])).toBeUndefined();
  });
});

test("rowText reads content and parts, text or content", () => {
  expect(rowText({ content: "a" })).toBe("a");
  expect(rowText({ content: [{ text: "b" }] })).toBe("b");
  expect(rowText({ content: "c", parts: [{ content: "d" }, { text: "e" }, null] })).toBe("c\nd\ne");
});

test("submitCount counts the submit tool under any server prefix", () => {
  expect(
    submitCount({
      submit_subork_answer: 1,
      orkestrator_submit_subork_answer: 2,
      ask_agents: 4,
      other_tool: 8,
    }),
  ).toBe(3);
});
