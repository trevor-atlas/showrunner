/**
 * @showrunner view-models — pure data-assembly layer for the dashboard reads.
 *
 * A view-model takes ids + persistence handles and returns serializable shapes:
 * no SQL, HTTP, React, writes, commands, or view state. #47 seeds this module
 * with the phase-record model (the single owner of a phase read); it is dead
 * code until #48 wires the controller to it.
 */
export { buildPhaseRecordModel } from "./phase-record.ts";
export type { PhaseRecordModel } from "./phase-record.ts";
export { buildRunStats } from "./run-stats.ts";
export { buildRunList } from "./run-list.ts";
export { buildRunDetail, buildSpendBreakdown, buildTimeline } from "./run-detail.ts";
export type { RunDetailOptions } from "./run-detail.ts";
