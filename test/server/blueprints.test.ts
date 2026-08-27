import { test, expect } from "bun:test";

import { cleanupDir, tmpDataDir } from "./helpers.ts";
import { materializeTemplates } from "../../src/server/services/templates.ts";
import { describeBlueprint, listBlueprints, loadBlueprintByName } from "../../src/server/services/blueprints.ts";

/**
 * SAFETY: every test writes ONLY into a fresh mkdtemp dir and materializes the
 * real starter kit into it. Nothing here reads or writes a developer's real
 * ~/.showrunner. The data dir is the source of truth for blueprints.
 */

test("loadBlueprintByName imports and validates a data-dir blueprint copy as a real Blueprint", async () => {
  const dataDir = tmpDataDir("blueprints-load");
  try {
    materializeTemplates(dataDir);

    const bp = await loadBlueprintByName(dataDir, "scout");
    expect(bp.name).toBe("scout");
    expect(bp.phases.map((p) => p.name)).toEqual(["recon"]);
    expect(bp.phases[0]!.agent.name).toBe("scout");
  } finally {
    cleanupDir(dataDir);
  }
});

test("listBlueprints returns every starter blueprint with its ordered phase chain", async () => {
  const dataDir = tmpDataDir("blueprints-list");
  try {
    materializeTemplates(dataDir);

    const summaries = await listBlueprints(dataDir);
    const names = summaries.map((s) => s.name);
    expect(names).toContain("scout");
    expect(names).toContain("plan_build_test");
    // the shared helpers are never listed as blueprints
    expect(names).not.toContain("patterns");
    expect(names).not.toContain("index");

    const scout = summaries.find((s) => s.name === "scout")!;
    expect(scout.phases).toEqual(["recon"]);

    const pbt = summaries.find((s) => s.name === "plan_build_test")!;
    expect(pbt.phases).toEqual(["plan", "build", "review", "ship"]);
  } finally {
    cleanupDir(dataDir);
  }
});

test("describeBlueprint returns per-phase detail: agent, budget, on_fail, approval", async () => {
  const dataDir = tmpDataDir("blueprints-describe");
  try {
    materializeTemplates(dataDir);

    const detail = await describeBlueprint(dataDir, "plan_build_test");
    expect(detail).not.toBeNull();
    expect(detail!.name).toBe("plan_build_test");
    expect(detail!.phases.map((p) => p.name)).toEqual(["plan", "build", "review", "ship"]);

    const build = detail!.phases.find((p) => p.name === "build")!;
    expect(build.agent).toBe("builder");
    expect(build.budget).toBe(3);
    expect(build.on_fail).toBe("plan");
    expect(build.require_approval).toBe(false);

    const review = detail!.phases.find((p) => p.name === "review")!;
    expect(review.on_fail).toBe("build");

    const ship = detail!.phases.find((p) => p.name === "ship")!;
    expect(ship.require_approval).toBe(true);
    expect(ship.on_fail).toBeNull();
  } finally {
    cleanupDir(dataDir);
  }
});

test("describeBlueprint returns null for an unknown name", async () => {
  const dataDir = tmpDataDir("blueprints-describe-unknown");
  try {
    materializeTemplates(dataDir);
    expect(await describeBlueprint(dataDir, "nope")).toBeNull();
  } finally {
    cleanupDir(dataDir);
  }
});

test("loadBlueprintByName on an unknown name throws listing the available names", async () => {
  const dataDir = tmpDataDir("blueprints-unknown");
  try {
    materializeTemplates(dataDir);

    let err: Error | null = null;
    try {
      await loadBlueprintByName(dataDir, "nope");
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toContain("nope");
    expect(err!.message).toContain("scout");
    expect(err!.message).toContain("plan_build_test");
    // the non-blueprint files are never offered as names
    expect(err!.message).not.toContain("patterns");
    expect(err!.message).not.toContain("index");
  } finally {
    cleanupDir(dataDir);
  }
});
