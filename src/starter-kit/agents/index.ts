export { planner } from "./planner.ts";
export { builder } from "./builder.ts";
export { scout } from "./scout.ts";
export { reviewer } from "./reviewer.ts";
export { documenter } from "./documenter.ts";
export { ship } from "./ship.ts";

import type { Agent } from "../../core/index.ts";
import { builder } from "./builder.ts";
import { documenter } from "./documenter.ts";
import { planner } from "./planner.ts";
import { reviewer } from "./reviewer.ts";
import { scout } from "./scout.ts";
import { ship } from "./ship.ts";

/** The six agents by name — the starter kit's roster of doers (PLAN §14). */
export const AGENTS: Record<string, Agent> = {
  planner,
  builder,
  scout,
  reviewer,
  documenter,
  ship,
};
