/**
 * A project board in memory for the self-improvement tests: tickets with
 * statuses, comments and labels, behind the same `Board` a run files on.
 */
import type { Board, BoardTicket } from "../loop.js";

export interface FakeTicket extends BoardTicket {
  description: string;
  criteria: string;
  comments: string[];
  labels: string[];
}

/** Board calls a test makes fail: the operation throws on its Nth call (1-based). */
type FailingOperation = "create" | "comment" | "moveToBacklog";
export type FakeBoardFailures = Partial<Record<FailingOperation, number>>;

export class FakeBoard implements Board {
  readonly tickets = new Map<string, FakeTicket>();
  readonly labels = new Set<string>();
  /** Comment request ids already posted, as Kanban storage keeps them. */
  readonly commentRequests = new Set<string>();
  readonly failures: FakeBoardFailures = {};
  /** Where a ticket on any project is; a test sets it to model other boards. */
  locate?: (ticketId: string) => Promise<string | null>;
  private readonly calls = { create: 0, comment: 0, moveToBacklog: 0 };
  private nextId: number;

  constructor(
    readonly projectId = "p1",
    firstId = 100,
  ) {
    this.nextId = firstId;
  }

  private call(operation: FailingOperation): void {
    this.calls[operation] += 1;
    if (this.failures[operation] === this.calls[operation]) {
      throw new Error(`${operation} failed`);
    }
  }

  async get(ticketId: string): Promise<BoardTicket | null> {
    return this.tickets.get(ticketId) ?? null;
  }

  async list(): Promise<BoardTicket[]> {
    return [...this.tickets.values()];
  }

  async create(input: Parameters<Board["create"]>[0]): Promise<string> {
    this.call("create");
    const id = String(this.nextId++);
    this.tickets.set(id, {
      id,
      title: input.title,
      status: "backlog",
      description: input.description,
      criteria: input.criteria,
      comments: [],
      labels: [input.label],
    });
    return id;
  }

  async comment(ticketId: string, text: string, requestId: string): Promise<void> {
    this.call("comment");
    const ticket = this.tickets.get(ticketId);
    if (!ticket) throw new Error(`Kanban task not found: ${ticketId}`);
    if (this.commentRequests.has(requestId)) return;
    this.commentRequests.add(requestId);
    ticket.comments.push(text);
  }

  async moveToBacklog(ticketId: string): Promise<void> {
    this.call("moveToBacklog");
    const ticket = this.tickets.get(ticketId);
    if (!ticket) throw new Error(`Kanban task not found: ${ticketId}`);
    ticket.status = "backlog";
  }

  async ensureLabels(labels: ReadonlyArray<{ name: string }>): Promise<void> {
    for (const label of labels) this.labels.add(label.name);
  }

  /** The ticket filed for a signature (its description names it). */
  ticketFor(signature: string): FakeTicket {
    const found = [...this.tickets.values()].find((ticket) =>
      ticket.description.includes(signature),
    );
    if (!found) throw new Error(`No ticket for ${signature}`);
    return found;
  }
}
