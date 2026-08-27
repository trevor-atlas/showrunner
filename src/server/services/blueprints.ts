import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Blueprint } from "../../core/index.ts";
import { DEFAULT_BUDGET } from "../../core/index.ts";
import { loadBlueprintModule } from "../engine/runner.ts";

/** Files in blueprints/ that are not themselves blueprints. */
const NON_BLUEPRINT_FILES = new Set(["index.ts", "patterns.ts"]);

/** A blueprint at a glance: its name and its ordered phase chain. */
export interface BlueprintSummary {
  name: string;
  phases: string[];
}

/** One phase's configuration, for the blueprint-detail view. */
export interface BlueprintPhaseDetail {
  name: string;
  agent: string;
  budget: number;
  /** the on_fail branch target, or null when the phase gives up in place */
  on_fail: string | null;
  require_approval: boolean;
}

/** A blueprint's full per-phase detail. */
export interface BlueprintDetail {
  name: string;
  phases: BlueprintPhaseDetail[];
}

/**
 * Blueprint discovery over a materialized data dir. The data dir is the source
 * of truth: user-editable blueprint copies live at
 * <dataDir>/templates/blueprints/<name>.ts, imported through the symlinks
 * materializeTemplates lays down (core + node_modules). Names map to modules;
 * there is no path form.
 */

/** The directory holding the data dir's blueprint modules. */
function blueprintsDir(dataDir: string): string {
  return join(dataDir, "templates", "blueprints");
}

/** The module path a blueprint name resolves to. */
export function blueprintModulePath(dataDir: string, name: string): string {
  return join(blueprintsDir(dataDir), `${name}.ts`);
}

/**
 * The blueprint names available in the data dir, sorted. Every `.ts` module in
 * blueprints/ is a blueprint except the shared helpers (index.ts, patterns.ts);
 * the fake-pi/ scripted-session dir is a directory, never a name.
 */
export function listBlueprintNames(dataDir: string): string[] {
  const dir = blueprintsDir(dataDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts") && !NON_BLUEPRINT_FILES.has(e.name))
    .map((e) => e.name.slice(0, -".ts".length))
    .sort();
}

/**
 * List every blueprint in the data dir with its ordered phase chain. Each
 * module is imported + validated (a broken blueprint surfaces at discovery, not
 * at submit); the shared helpers and the fake-pi/ dir are excluded by
 * listBlueprintNames.
 */
export async function listBlueprints(dataDir: string): Promise<BlueprintSummary[]> {
  const summaries: BlueprintSummary[] = [];
  for (const name of listBlueprintNames(dataDir)) {
    const bp = await loadBlueprintByName(dataDir, name);
    summaries.push({ name: bp.name, phases: bp.phases.map((p) => p.name) });
  }
  return summaries;
}

/**
 * Full per-phase detail for one blueprint: each phase's agent, budget, on_fail
 * target, and approval requirement, in execution order. Returns null when the
 * name does not resolve to a blueprint in the data dir.
 */
export async function describeBlueprint(dataDir: string, name: string): Promise<BlueprintDetail | null> {
  if (!existsSync(blueprintModulePath(dataDir, name))) return null;
  const bp = await loadBlueprintByName(dataDir, name);
  return {
    name: bp.name,
    phases: bp.phases.map((p) => ({
      name: p.name,
      agent: p.agent.name,
      budget: p.budget ?? DEFAULT_BUDGET,
      on_fail: p.on_fail?.to ?? null,
      require_approval: p.require_approval ?? false,
    })),
  };
}

/**
 * Import + validate the data-dir blueprint copy named `name`. Reuses the
 * runner's loadBlueprintModule (import + validateBlueprint) so a data-dir
 * blueprint is held to exactly the same contract as any other. Unknown name →
 * throws, listing the available names.
 */
export async function loadBlueprintByName(dataDir: string, name: string): Promise<Blueprint> {
  const modulePath = blueprintModulePath(dataDir, name);
  if (!existsSync(modulePath)) {
    const available = listBlueprintNames(dataDir);
    throw new Error(
      `unknown blueprint "${name}" — available blueprints: ${available.join(", ") || "(none)"}`,
    );
  }
  return loadBlueprintModule(modulePath);
}
