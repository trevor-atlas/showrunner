import { expect, test } from "bun:test";

import plan from "../../src/starter-kit/blueprints/plan.ts";
import plan_build from "../../src/starter-kit/blueprints/plan_build.ts";
import plan_build_test from "../../src/starter-kit/blueprints/plan_build_test.ts";
import build from "../../src/starter-kit/blueprints/build.ts";
import build_review from "../../src/starter-kit/blueprints/build_review.ts";
import document from "../../src/starter-kit/blueprints/document.ts";
import everything from "../../src/starter-kit/blueprints/everything.ts";

import { builder } from "../../src/starter-kit/agents/builder.ts";
import { documenter } from "../../src/starter-kit/agents/documenter.ts";
import { planner } from "../../src/starter-kit/agents/planner.ts";
import { reviewer } from "../../src/starter-kit/agents/reviewer.ts";
import { ship } from "../../src/starter-kit/agents/ship.ts";
import { BuildEnvelope, DocumentEnvelope, PlanEnvelope, ReviewEnvelope, ShipEnvelope } from "../../src/starter-kit/envelopes.ts";
import type { Blueprint, BlueprintPhase } from "../../src/core/index.ts";

/**
 * Shape guard for the planning blueprints. plan / plan_build / plan_build_test
 * compose from src/starter-kit/blueprints/patterns.ts (#61). This test pins the
 * exact runtime shape they must produce — expected values are the ORIGINAL
 * hand-rolled phase definitions, so the dedup refactor cannot silently change a
 * name, agent, envelope, gate set/order, budget, on_fail target, or approval
 * flag. If an assertion here has to change to pass, a runtime shape changed.
 */

interface PhaseShape {
  name: string;
  agent: unknown;
  envelope: unknown;
  gates: string[];
  budget: number | undefined;
  on_fail: { to: string } | undefined;
  require_approval: boolean | undefined;
}

function shapeOf(p: BlueprintPhase): PhaseShape {
  return {
    name: p.name,
    agent: p.agent,
    envelope: p.envelope,
    gates: p.gates.map((g) => g.name),
    budget: p.budget,
    on_fail: p.on_fail,
    require_approval: p.require_approval,
  };
}

function blueprintShape(b: Blueprint): { name: string; phases: PhaseShape[] } {
  return { name: b.name, phases: b.phases.map(shapeOf) };
}

const planPhaseShape: PhaseShape = {
  name: "plan",
  agent: planner,
  envelope: PlanEnvelope,
  gates: [],
  budget: 3,
  on_fail: undefined,
  require_approval: undefined,
};

const shipPhaseShape: PhaseShape = {
  name: "ship",
  agent: ship,
  envelope: ShipEnvelope,
  gates: [],
  budget: 3,
  on_fail: undefined,
  require_approval: true,
};

test("plan composes to the pinned runtime shape", () => {
  expect(blueprintShape(plan)).toEqual({
    name: "plan",
    phases: [planPhaseShape],
  });
});

test("plan_build composes to the pinned runtime shape", () => {
  expect(blueprintShape(plan_build)).toEqual({
    name: "plan_build",
    phases: [
      planPhaseShape,
      {
        name: "build",
        agent: builder,
        envelope: BuildEnvelope,
        gates: ["matchesPlan"],
        budget: 3,
        on_fail: { to: "plan" },
        require_approval: undefined,
      },
      shipPhaseShape,
    ],
  });
});

test("plan_build_test composes to the pinned runtime shape", () => {
  expect(blueprintShape(plan_build_test)).toEqual({
    name: "plan_build_test",
    phases: [
      planPhaseShape,
      {
        name: "build",
        agent: builder,
        envelope: BuildEnvelope,
        gates: ["matchesPlan", "testsPass", "lintClean"],
        budget: 3,
        on_fail: { to: "plan" },
        require_approval: undefined,
      },
      {
        name: "review",
        agent: reviewer,
        envelope: ReviewEnvelope,
        gates: ["reviewApproved"],
        budget: 3,
        on_fail: { to: "build" },
        require_approval: undefined,
      },
      shipPhaseShape,
    ],
  });
});

test("build composes to the pinned runtime shape", () => {
  expect(blueprintShape(build)).toEqual({
    name: "build",
    phases: [
      {
        name: "build",
        agent: builder,
        envelope: BuildEnvelope,
        gates: [],
        budget: 3,
        on_fail: undefined,
        require_approval: undefined,
      },
    ],
  });
});

test("build_review composes to the pinned runtime shape", () => {
  expect(blueprintShape(build_review)).toEqual({
    name: "build_review",
    phases: [
      {
        name: "build",
        agent: builder,
        envelope: BuildEnvelope,
        gates: [],
        budget: 3,
        on_fail: { to: "review" },
        require_approval: undefined,
      },
      {
        name: "review",
        agent: reviewer,
        envelope: ReviewEnvelope,
        gates: ["reviewApproved"],
        budget: 3,
        on_fail: { to: "build" },
        require_approval: undefined,
      },
    ],
  });
});

test("document composes to the pinned runtime shape", () => {
  expect(blueprintShape(document)).toEqual({
    name: "document",
    phases: [
      {
        name: "document",
        agent: documenter,
        envelope: DocumentEnvelope,
        gates: ["filesExist"],
        budget: 3,
        on_fail: undefined,
        require_approval: undefined,
      },
    ],
  });
});

test("everything composes to the pinned runtime shape", () => {
  expect(blueprintShape(everything)).toEqual({
    name: "everything",
    phases: [
      {
        name: "plan",
        agent: planner,
        envelope: PlanEnvelope,
        gates: [],
        budget: 4,
        on_fail: undefined,
        require_approval: true,
      },
      {
        name: "build",
        agent: builder,
        envelope: BuildEnvelope,
        gates: ["matchesPlan", "testsPass", "lintClean"],
        budget: 4,
        on_fail: { to: "plan" },
        require_approval: undefined,
      },
      {
        name: "review",
        agent: reviewer,
        envelope: ReviewEnvelope,
        gates: ["reviewApproved"],
        budget: 4,
        on_fail: { to: "build" },
        require_approval: undefined,
      },
      shipPhaseShape,
    ],
  });
});
