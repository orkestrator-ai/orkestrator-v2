/**
 * Suborks through a real OpenCode 2.x process: the pinned `opencode2 serve`,
 * talking to a scripted OpenAI-compatible model on loopback, with the real
 * agent tools server, subork service, branch runner and mail drain. No billed
 * turn, login or real data directory is involved: the fixture runs 2.x with a
 * throwaway HOME, XDG directories and database (`startOpenCode2Fixture`), and
 * the "model" is this file's script.
 *
 * It replaces the 1.x qualification retired with OpenCode 1.x, and proves
 * what the fake-provider suites cannot:
 * - a real 2.x caller tab reaches `ask_agents` through its own per-tab MCP
 *   server (`agentMcp`), with the shared description offered to the model;
 * - a real 2.x subork runs as a read-only result turn: it never sees
 *   `ask_agents` (depth 1), any tab tool or anything of the caller's
 *   conversation, and answers through `submit_subork_answer` on its result
 *   connection;
 * - the labelled answers are mailed back and continue the real caller
 *   session.
 *
 * What a real model does with the description is still not shown: here the
 * script decides to call the tool. Run with RUN_LIVE_OPENCODE2=1 and
 * OPENCODE2_CLI_PATH set to the pinned 2.x binary (`mise run verify:opencode2:live`).
 */
import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { SUBORK_TOOL_NAME } from "@orkestrator/protocol/suborks";
import {
  startOpenCode2Fixture,
  type OpenCode2Fixture,
} from "../../../../../scripts/opencode2-steer-probe.js";
import { AgentMailService } from "../agent-mail-service.js";
import { SUBORK_TOOL_DESCRIPTION } from "../agent-tools-subork-schema.js";
import type { BuildPipelineProvider } from "../build-pipeline-provider.js";
import { GraphAgentProviders } from "../graph-agent-providers.js";
import { CATALOG, suborkWorld, type SuborkWorld } from "../native-agent-suborks-test-support.js";
import { OpenCodeEnvironmentProvider } from "./environment-provider.js";
import { openCode2TabMcpServer, OPENCODE2_TAB_MCP_PREFIX } from "./permissions.js";
import { openCodeWorkflowResultToolId } from "./policy-rules.js";
import { OpenCode2Client } from "./client.js";
import { OpenCode2Provider } from "./provider.js";

const binary = process.env.OPENCODE2_CLI_PATH?.trim();
const live = process.env.RUN_LIVE_OPENCODE2 === "1" && !!binary;
const liveTest = live ? test : test.skip;

const CALLER_REQUEST = "Please ask codex and opencode to review this index.html for me.";
const SUBORK_PROMPT =
  "Review index.html in the current working directory and say what you would change.";
const OPENCODE_ANSWER = "OpenCode read index.html: add a lang attribute.";
const SUBMIT_TOOL = openCodeWorkflowResultToolId("submit_subork_answer");

liveTest(
  "a real 2.x caller reaches ask_agents, a real 2.x subork answers at depth one, and the caller continues",
  async () => {
    let fixture: OpenCode2Fixture | undefined;
    let w: SuborkWorld | undefined;
    let caller: OpenCode2Provider | undefined;
    let mail: AgentMailService | undefined;
    const suborkProviders: OpenCodeEnvironmentProvider[] = [];
    const seen = {
      askTool: "",
      callerTools: [] as string[],
      askDescription: undefined as string | undefined,
      suborkTools: [] as string[][],
      suborkText: [] as string[],
      continuation: undefined as string | undefined,
    };
    try {
      fixture = await startOpenCode2Fixture(binary!);
      const f = fixture;
      await writeFile(join(f.directory, "index.html"), "<html><body>hi</body></html>\n");
      f.model.respond = ({ texts, lastRole, tools, descriptions }) => {
        const all = texts.join("\n");
        // Title generation (no tools offered) is not the subork's turn.
        if (tools.length === 0) return { text: "Review" };
        if (all.includes("submit_subork_answer")) {
          seen.suborkTools.push(tools);
          seen.suborkText.push(all);
          if (lastRole === "tool" || !tools.includes(SUBMIT_TOOL)) return { text: "Done." };
          const resultKey = /resultKey "([^"]+)"/.exec(all)?.[1];
          const capability = /capability "([^"]+)"/.exec(all)?.[1];
          return {
            tool: SUBMIT_TOOL,
            arguments: {
              resultKey,
              ...(capability ? { capability } : {}),
              result: { answer: OPENCODE_ANSWER },
            },
          };
        }
        if (all.includes("codex says hi") && lastRole === "user") {
          seen.continuation = all;
          return { text: "Both answered; carrying on." };
        }
        if (all.includes(CALLER_REQUEST) && seen.askTool && tools.includes(seen.askTool)) {
          if (lastRole === "tool") return { text: "Asked them; the answers will arrive by mail." };
          seen.callerTools = tools;
          seen.askDescription = descriptions[seen.askTool];
          return {
            tool: seen.askTool,
            arguments: {
              tabId: "agent",
              targets: [{ agent: "codex" }, { agent: "opencode", model: "fixture" }],
              prompt: SUBORK_PROMPT,
            },
          };
        }
        return undefined;
      };

      const connection = {
        baseUrl: f.baseUrl,
        password: f.password,
        directory: f.directory,
        generation: "live-1",
      };
      let world: SuborkWorld | undefined;
      w = world = await suborkWorld({
        service: {
          providers: new GraphAgentProviders({
            create: async (_environment, agent: AgentPlatform) => {
              if (agent !== "opencode") return world!.provider(agent).asProvider();
              const provider = new OpenCodeEnvironmentProvider({
                connection: async () => connection,
              });
              suborkProviders.push(provider);
              return provider as unknown as BuildPipelineProvider;
            },
          }),
          modelCatalog: async () => [
            ...CATALOG,
            { platform: "opencode", id: "fixture/fixture", label: "Fixture" },
          ],
          settingsTiers: async () => ({
            global: { platforms: { codex: { model: "gpt-6.1-sol" } } },
          }),
        },
      });
      // The caller is an OpenCode tab.
      const layout = (await w.storage.getPaneLayout("e1"))!;
      const root0 = layout.root as { tabs: { nativeAgentData?: { platform: string } }[] };
      root0.tabs[0]!.nativeAgentData!.platform = "opencode";
      await w.storage.savePaneLayout("e1", layout, layout.revision);
      await w.storage.synchronizeAgentMailboxes();

      // The caller tab's own credential, as a native tab's per-tab `agentMcp`.
      const tabConnection = w.agentTools.connection("e1", "p1", "host", "agent");
      caller = new OpenCode2Provider(
        new OpenCode2Client({ baseUrl: f.baseUrl, password: f.password, directory: f.directory }),
      );
      const callerId = await caller.createSession("build", "Caller", { model: "fixture/fixture" });
      seen.askTool = `${openCode2TabMcpServer(callerId)}_${SUBORK_TOOL_NAME}`;
      const settled = async (id: string, requestId: string, timeoutMs = 60_000) => {
        const deadline = Date.now() + timeoutMs;
        while (
          (await caller!.dispatchStatus(id, requestId)) !== "dispatched" ||
          (await caller!.activity(id)) !== "idle" ||
          !(await caller!.settleTurn(id, requestId))
        ) {
          if (Date.now() > deadline) throw new Error("The caller turn did not settle");
          await Bun.sleep(150);
        }
      };
      await caller.send(callerId, CALLER_REQUEST, {
        requestId: "caller-1",
        agentMcp: { url: tabConnection.url, token: tabConnection.token },
      });
      await settled(callerId, "caller-1");

      // The tool was offered to the model, and the model's call reached the service.
      expect(seen.callerTools).toContain(seen.askTool);
      const handleText =
        f.model.calls.findLast((call) => call.toolResult?.includes("batchId"))?.toolResult ?? "";
      const handle = JSON.parse(handleText) as { batchId: string; suborks: { status: string }[] };
      expect(handle.suborks.map((subork) => subork.status)).toEqual(["starting", "starting"]);
      expect(seen.askDescription).toContain(SUBORK_TOOL_DESCRIPTION.slice(0, 80));

      const deadline = Date.now() + 90_000;
      for (;;) {
        const view = await w.service.advanceNow(handle.batchId);
        await w.settleProviders();
        if (view && view.status !== "running" && view.delivery !== "waiting") break;
        if (Date.now() >= deadline) throw new Error("The suborks did not settle");
        await Bun.sleep(150);
      }

      // Depth 1 and prompt isolation, as the real 2.x subork saw them.
      expect(seen.suborkTools.length).toBeGreaterThan(0);
      for (const names of seen.suborkTools) {
        expect(names).toContain(SUBMIT_TOOL);
        expect(names.some((name) => name.endsWith(`_${SUBORK_TOOL_NAME}`))).toBe(false);
        // No tab server of any session: only the turn's result connection.
        expect(names.filter((name) => name.startsWith(OPENCODE2_TAB_MCP_PREFIX))).toEqual([]);
        const resultPrefix = openCodeWorkflowResultToolId("");
        expect(
          names.filter((name) => name.startsWith("orkestrator_") && !name.startsWith(resultPrefix)),
        ).toEqual([]);
        // A read-only turn: 2.x offers neither its editing tools nor its own subagents.
        for (const tool of ["edit", "write", "subagent"]) expect(names).not.toContain(tool);
      }
      // The caller, a build turn, was offered them: the difference is the subork's policy.
      expect(seen.callerTools).toEqual(expect.arrayContaining(["edit", "write"]));
      const suborkSaw = seen.suborkText.join("\n");
      expect(suborkSaw).toContain(SUBORK_PROMPT);
      expect(suborkSaw).not.toContain(CALLER_REQUEST);

      const [delivered] = await w.mail();
      expect(delivered?.body).toContain("codex says hi");
      expect(delivered?.body).toContain(OPENCODE_ANSWER);
      expect(delivered?.body).toContain("OpenCode · Fixture");

      // The real mail drain continues the real caller session with the answers.
      mail = new AgentMailService(
        w.storage,
        {
          sessionActivitySnapshot: () => "idle",
          mailInjectPresence: async () => "idle",
          reconcileMailInject: async () => "not-dispatched",
          dispatchMailInject: async (input) => {
            await caller!.send(callerId, input.prompt, { requestId: input.requestId });
            await settled(callerId, input.requestId);
            return { outcome: "accepted", requestId: input.requestId };
          },
        },
        {
          dispatchMailInject: async () => {
            throw new Error("unexpected terminal dispatch");
          },
        },
      );
      await mail.drainInjects();
      expect(seen.continuation).toContain(OPENCODE_ANSWER);
      expect(seen.continuation).toContain("Codex · GPT-6.1 Sol");
    } finally {
      await mail?.shutdown();
      await caller?.dispose();
      await Promise.all(suborkProviders.map((provider) => provider.dispose?.()));
      await w?.cleanup();
      await fixture?.stop();
    }
  },
  180_000,
);
