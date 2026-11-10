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

export class FakeBoard implements Board {
  readonly tickets = new Map<string, FakeTicket>();
  readonly labels = new Set<string>();
  private nextId = 100;

  async get(ticketId: string): Promise<BoardTicket | null> {
    return this.tickets.get(ticketId) ?? null;
  }

  async list(): Promise<BoardTicket[]> {
    return [...this.tickets.values()];
  }

  async create(input: Parameters<Board["create"]>[0]): Promise<string> {
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

  async comment(ticketId: string, text: string): Promise<void> {
    this.tickets.get(ticketId)!.comments.push(text);
  }

  async moveToBacklog(ticketId: string): Promise<void> {
    this.tickets.get(ticketId)!.status = "backlog";
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
