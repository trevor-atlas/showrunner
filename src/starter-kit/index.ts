/**
 * @showrunner/starter-kit — the out-of-the-box Showrunner content.
 * Six agents, a shared gates library, the poll tool, ten
 * blueprints, and one operator skill (installed into ~/.agents/skills, not the
 * data dir) — all of it a replace-this surface.
 */

// Model roster — the replaceable "models that were good this week"
export { DEFAULT_MODEL_ROLE, MODELS, modelFor } from "./models.ts";
export type { ModelRole, RosterEntry } from "./models.ts";

// The six agents
export { AGENTS } from "./agents/index.ts";
export { planner } from "./agents/planner.ts";
export { builder } from "./agents/builder.ts";
export { scout } from "./agents/scout.ts";
export { reviewer } from "./agents/reviewer.ts";
export { documenter } from "./agents/documenter.ts";
export { ship } from "./agents/ship.ts";

// The envelope schemas the six agents' phases parse against
export {
  BuildEnvelope,
  DocumentEnvelope,
  PlanEnvelope,
  ReviewEnvelope,
  ScoutEnvelope,
  ShipEnvelope,
} from "./envelopes.ts";
export type {
  BuildEnvelope as BuildEnvelopeType,
  DocumentEnvelope as DocumentEnvelopeType,
  PlanEnvelope as PlanEnvelopeType,
  ReviewEnvelope as ReviewEnvelopeType,
  ScoutEnvelope as ScoutEnvelopeType,
  ShipEnvelope as ShipEnvelopeType,
} from "./envelopes.ts";

// The shared gates library
export {
  envelopeShape,
  filesExist,
  findingsReported,
  inputsDirFor,
  lintClean,
  matchesPlan,
  outputsDirFor,
  reviewApproved,
  testsPass,
  workspaceShell,
} from "./gates/index.ts";
export type {
  CommandGateOptions,
  EnvelopeShapeOptions,
  FilesExistOptions,
  MatchesPlanOptions,
  ReviewApprovedOptions,
} from "./gates/index.ts";

// The ten blueprints
export { BLUEPRINTS } from "./blueprints/index.ts";
export { default as promptBlueprint, promptBlueprint as makePromptBlueprint } from "./blueprints/prompt.ts";
export { default as scoutBlueprint } from "./blueprints/scout.ts";
export { default as planBlueprint } from "./blueprints/plan.ts";
export { default as buildBlueprint } from "./blueprints/build.ts";
export { default as planBuildBlueprint } from "./blueprints/plan_build.ts";
export { default as buildTestBlueprint } from "./blueprints/build_test.ts";
export { default as buildReviewBlueprint } from "./blueprints/build_review.ts";
export { default as planBuildTestBlueprint } from "./blueprints/plan_build_test.ts";
export { default as documentBlueprint } from "./blueprints/document.ts";
export { default as everythingBlueprint } from "./blueprints/everything.ts";
