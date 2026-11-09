import { expect, test } from "bun:test";
import { isNodeReadCommand } from "./command-nodes.js";

test("read verbs may lead a command or follow one namespace", () => {
  for (const command of [
    "get_projects",
    "list_nodes",
    "read_file",
    "search_files",
    "check_status",
    "describe_node",
    "changes_get_view",
    "changes_read_content",
    "v2_list_items",
    "graph_run_get",
    "graph_runs_list",
    "graph_template_get",
    "graph_run_effects",
    "auto_pipeline_sources",
  ])
    expect(isNodeReadCommand(command)).toBe(true);
  for (const command of [
    "create_environment",
    "draft_auto_pipeline",
    "confirm_auto_pipeline",
    "changes_reset_view",
    "forget_project",
    "target_get",
    "get",
    "",
    "changes_nested_get_view",
    "Get_projects",
    "getaway_home",
    "graph_run_cancel",
    "graph_run_launch",
    "graph_run_answer",
    "graph_describe_start",
    "graph_describe_cancel",
  ])
    expect(isNodeReadCommand(command)).toBe(false);
});
