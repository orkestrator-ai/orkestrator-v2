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
  ])
    expect(isNodeReadCommand(command)).toBe(true);
  for (const command of [
    "create_environment",
    "changes_reset_view",
    "forget_project",
    "target_get",
    "get",
    "",
    "changes_nested_get_view",
    "Get_projects",
    "getaway_home",
  ])
    expect(isNodeReadCommand(command)).toBe(false);
});
