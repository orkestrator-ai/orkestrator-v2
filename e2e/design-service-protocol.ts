/** Wire format shared by `design-service-host.ts` (Bun) and its Node client. */

/** The single environment the hosted command context resolves. */
export const DESIGN_FIXTURE_ENVIRONMENT = "design-fixture";

/** Service methods a spec may call directly, outside the command registry. */
export const DESIGN_SERVICE_METHODS = [
  "create",
  "createFrame",
  "get",
  "getFrame",
  "mutate",
] as const;
export type DesignServiceMethod = (typeof DESIGN_SERVICE_METHODS)[number];

/** Marks protocol replies on stdout, so backend log lines cannot be mistaken for one. */
export const REPLY_PREFIX = "@@design-host ";

export type DesignHostRequest = {
  id: number;
  kind: "invoke" | "service" | "action" | "close";
  name: string;
  args: unknown[];
};

export type DesignHostReply =
  { id: number; ok: true; result: unknown } | { id: number; ok: false; message: string };
