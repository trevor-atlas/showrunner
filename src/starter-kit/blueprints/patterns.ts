import type { BlueprintPhase, Gate } from "../../core/index.ts";
import { builder } from "../agents/builder.ts";
import { documenter } from "../agents/documenter.ts";
import { planner } from "../agents/planner.ts";
import { reviewer } from "../agents/reviewer.ts";
import { ship } from "../agents/ship.ts";
import { BuildEnvelope, DocumentEnvelope, PlanEnvelope, ReviewEnvelope, ShipEnvelope } from "../envelopes.ts";
import { filesExist, lintClean, matchesPlan, reviewApproved, testsPass } from "../gates/index.ts";

/**
 * Shared phase patterns for the demo blueprints (plan, plan_build,
 * plan_build_test, build, build_review, document, everything). Each helper
 * returns a fresh BlueprintPhase identical to the hand-rolled definition it
 * replaces, so blueprints COMPOSE their phase lists from this catalog instead
 * of repeating the same phase objects. This is a dedup: the produced runtime
 * shape is unchanged; only the source composition moves here.
 *
 * Replace-this: these defaults describe the demo flows. Edit a helper (or stop
 * using it and inline a phase) when your play needs something else.
 */

/** The default correction budget the phases share. */
const BUDGET = 3;

/**
 * plan — a single planner phase that produces a plan document. Its envelope
 * requires a plan_path (PlanEnvelope), so a planner that wrote no plan cannot
 * pass. Shared by plan, plan_build, plan_build_test, and everything. With
 * `requireApproval`, the plan pauses for a human before anything is built
 * (everything's heavier plan gate); `budget` overrides the default budget.
 */
export function planPhase(opts: { budget?: number; requireApproval?: boolean } = {}): BlueprintPhase {
  const phase: BlueprintPhase = {
    name: "plan",
    agent: planner,
    envelope: PlanEnvelope,
    gates: [],
    budget: opts.budget ?? BUDGET,
  };
  if (opts.requireApproval) phase.require_approval = true;
  return phase;
}

/**
 * build — a builder phase that implements the work. By default the matchesPlan
 * gate refuses an envelope that does not reference the plan document and a
 * failed build routes back to planning (on_fail → plan) — the plan-driven
 * build shared by plan_build, plan_build_test, and everything. Options carve
 * out the standalone builds:
 *   - `withTests` also gates on a green suite + clean typecheck (testsPass +
 *     lintClean) — plan_build_test / everything.
 *   - `withPlan: false` drops the matchesPlan gate — the plan-less build /
 *     build_review flows.
 *   - `onFail` overrides the failure route; `null` omits on_fail entirely
 *     (build's give-up-in-place); `budget` overrides the default budget.
 */
export function buildPhase(
  opts: { withTests?: boolean; withPlan?: boolean; budget?: number; onFail?: { to: string } | null } = {},
): BlueprintPhase {
  const gates: Gate[] = [];
  if (opts.withPlan ?? true) gates.push(matchesPlan());
  if (opts.withTests) gates.push(testsPass(), lintClean());
  const phase: BlueprintPhase = {
    name: "build",
    agent: builder,
    envelope: BuildEnvelope,
    gates,
    budget: opts.budget ?? BUDGET,
  };
  const onFail = opts.onFail === undefined ? { to: "plan" } : opts.onFail;
  if (onFail) phase.on_fail = onFail;
  return phase;
}

/**
 * review — a reviewer phase whose reviewApproved gate demands approval; a
 * rejected review routes back to the builder (the bounded revise loop).
 * `budget` overrides the default budget (everything's heavier review).
 */
export function reviewPhase(opts: { budget?: number } = {}): BlueprintPhase {
  return {
    name: "review",
    agent: reviewer,
    envelope: ReviewEnvelope,
    gates: [reviewApproved()],
    budget: opts.budget ?? BUDGET,
    on_fail: { to: "build" },
  };
}

/**
 * ship — the terminal phase that pauses for a human (require_approval) before
 * any commit/PR is made.
 */
export function shipPhase(): BlueprintPhase {
  return {
    name: "ship",
    agent: ship,
    envelope: ShipEnvelope,
    gates: [],
    budget: BUDGET,
    require_approval: true,
  };
}

/**
 * document — a documenter phase that writes up what changed. The filesExist
 * gate refuses an envelope that lists no artifacts, so docs must actually have
 * been written, not just promised. Used by the document flow.
 */
export function documentPhase(): BlueprintPhase {
  return {
    name: "document",
    agent: documenter,
    envelope: DocumentEnvelope,
    gates: [filesExist()],
    budget: BUDGET,
  };
}
