import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  ADAPTER_LIST_PATH,
  ADAPTER_RETIREMENT_RULE,
  DOMAIN_CLIENTS,
  buildAdapterList,
  countedAdapterKeys,
  describeAdapterListDrift,
  hasDomainAdapter,
  parseAdapterList,
  serializeAdapterList,
} from "./client-adapters.js";
import { domainClient, isDomainClientDef } from "./client.js";
import { defineDomain } from "./domain.js";

const repoRoot = join(import.meta.dir, "../../../..");
const mail = defineDomain({ name: "node-mail", version: 2, min: 1 });
const tickets = defineDomain({ name: "ticket-sync", version: 1 });
const api = () => ({});
const mailClient = domainClient(mail, { 0: api, 2: api, 1: api });
const ticketClient = domainClient(tickets, { 1: api });

describe("buildAdapterList", () => {
  it("lists each domain's current version and adapters, sorted", () => {
    const list = buildAdapterList([ticketClient, mailClient]);
    expect(list.retirement).toBe(ADAPTER_RETIREMENT_RULE);
    expect(Object.keys(list.domains)).toEqual(["node-mail", "ticket-sync"]);
    expect(list.domains["node-mail"]).toEqual({ current: 2, adapters: [2, 1, 0] });
    expect(hasDomainAdapter(list, "node-mail", 0)).toBe(true);
    expect(hasDomainAdapter(list, "ticket-sync", 0)).toBe(false);
    expect(hasDomainAdapter(list, "nodes", 1)).toBe(false);
    expect([...countedAdapterKeys(list)].sort()).toEqual(["node-mail@0", "node-mail@1"]);
  });

  it("refuses two clients for one domain", () => {
    expect(() => buildAdapterList([mailClient, mailClient])).toThrow(/one per domain/);
  });

  it("round-trips through the committed text and reports drift", () => {
    const list = buildAdapterList([mailClient, ticketClient]);
    const text = serializeAdapterList(list);
    expect(text).toContain(`"node-mail": { "current": 2, "adapters": [2, 1, 0] },`);
    expect(text.endsWith("}\n")).toBe(true);
    expect(parseAdapterList(JSON.parse(text))).toEqual(list);
    expect(describeAdapterListDrift(text, list)).toEqual([]);
    expect(describeAdapterListDrift(null, list)).toEqual([`${ADAPTER_LIST_PATH} is missing.`]);
    const older = serializeAdapterList(buildAdapterList([ticketClient]));
    expect(describeAdapterListDrift(older, list)).toEqual(["node-mail: added (adapters 2, 1, 0)."]);
    expect(describeAdapterListDrift(text, buildAdapterList([ticketClient]))).toEqual([
      "node-mail: removed.",
    ]);
    expect(describeAdapterListDrift(text.replace("[2, 1, 0]", "[2, 0]"), list)).toEqual([
      "node-mail: committed current 2 adapters [2, 0], generated current 2 adapters [2, 1, 0].",
    ]);
    expect(describeAdapterListDrift("{", list)).toEqual([
      `${ADAPTER_LIST_PATH} is not valid JSON.`,
    ]);
  });

  it("parses only well-formed lists", () => {
    const base = JSON.parse(serializeAdapterList(buildAdapterList([mailClient])));
    expect(parseAdapterList({ ...base, schemaVersion: 2 })).toBeNull();
    for (const entry of [
      { current: 2, adapters: [1, 2] },
      { current: 2, adapters: [1, 0] },
      { current: 2, adapters: [2, 2] },
      { current: 0, adapters: [0] },
      { current: 2, adapters: "2" },
    ]) {
      expect(parseAdapterList({ ...base, domains: { "node-mail": entry } })).toBeNull();
    }
    expect(
      parseAdapterList({ ...base, domains: { unknown: { current: 1, adapters: [1] } } }),
    ).toBeNull();
  });
});

describe("the committed adapter list", () => {
  it("matches DOMAIN_CLIENTS", () => {
    const committed = readFileSync(join(repoRoot, ADAPTER_LIST_PATH), "utf8");
    expect(describeAdapterListDrift(committed, buildAdapterList(DOMAIN_CLIENTS))).toEqual([]);
  });

  it("holds every domain client definition in the repository", async () => {
    // A client defined anywhere but contract/domains/, or left out of
    // DOMAIN_CLIENTS, would be invisible to the CI job (plan item 1008).
    const roots = [
      ...["packages", "apps"].flatMap((parent) =>
        readdirSync(join(repoRoot, parent)).map((name) => join(repoRoot, parent, name, "src")),
      ),
      join(repoRoot, "apps/desktop/electron"),
    ].filter((root) => existsSync(root));
    const sources = roots
      .flatMap(walk)
      .filter((path) => readFileSync(path, "utf8").includes("domainClient("));
    const defining = sources
      .map((path) => relative(repoRoot, path))
      .filter((path) => path !== "packages/protocol/src/contract/client.ts");
    for (const path of defining) {
      expect(path.startsWith("packages/protocol/src/contract/domains/")).toBe(true);
      const module = (await import(join(repoRoot, path))) as Record<string, unknown>;
      for (const value of Object.values(module)) {
        if (isDomainClientDef(value)) expect(DOMAIN_CLIENTS).toContain(value);
      }
    }
  });
});

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".") || entry.name === "dist")
      continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(path));
    else if (/\.(ts|tsx)$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name))
      found.push(path);
  }
  return found;
}
