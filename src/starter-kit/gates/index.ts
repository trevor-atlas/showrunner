/**
 * Shared gates library. Each export is a curried gate
 * factory: `testsPass()` returns a Gate you drop into a phase's `gates` array.
 * Gates are workspace-aware via ctx (cwd, phase, visit) and use `ctx.shell()`
 * where a command must run — falling back to core's `createShell` when the
 * runtime does not provide one.
 *
 * Replace-this: the defaults (test command, lint command, plan-file naming)
 * describe the demo project. Override them per phase or edit these modules —
 * that is the point.
 *
 * This module is a barrel: the gate families live in focused modules
 * (command / handoff / file / verdict / envelope) with shared helpers in
 * ./shared, and this file re-exports the same public names.
 */

export { inputsDirFor, outputsDirFor, workspaceShell } from "./shared.ts";
export { type CommandGateOptions, lintClean, testsPass } from "./command.ts";
export { type EnvelopeShapeOptions, envelopeShape } from "./envelope.ts";
export { findingsReported, type MatchesPlanOptions, matchesPlan } from "./handoff.ts";
export { filesExist, type FilesExistOptions } from "./file.ts";
export { reviewApproved, type ReviewApprovedOptions } from "./verdict.ts";
