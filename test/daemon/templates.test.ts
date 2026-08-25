import { test, expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { cleanupDir, tmpDataDir } from "./helpers.ts";
import { materializeTemplates, syncTemplates } from "../../src/daemon/templates.ts";

/**
 * SAFETY: every test writes ONLY into a fresh mkdtemp dir. The starter-kit
 * source (src/starter-kit) is read-only input; nothing here reads or writes a
 * developer's real ~/.showrunner.
 */

test("first call materializes missing starter-kit files under <dataDir>/templates/", () => {
  const dataDir = tmpDataDir("templates-create");
  try {
    materializeTemplates(dataDir);

    // spot-check a known starter-kit file landed with the right content
    const readme = join(dataDir, "templates", "README.md");
    expect(existsSync(readme)).toBe(true);
    expect(readFileSync(readme, "utf8")).toContain("@showrunner/starter-kit");

    // a nested data file, reproducing the tree structure
    const fakePi = join(dataDir, "templates", "blueprints", "fake-pi", "plan.json");
    expect(existsSync(fakePi)).toBe(true);
    expect(readFileSync(fakePi, "utf8")).toContain("\"turns\"");
  } finally {
    cleanupDir(dataDir);
  }
});

test("never clobbers an existing destination file (copy-if-absent)", () => {
  const dataDir = tmpDataDir("templates-noclobber");
  try {
    const readme = join(dataDir, "templates", "README.md");
    mkdirSync(join(dataDir, "templates"), { recursive: true });
    writeFileSync(readme, "USER EDIT — do not touch");

    materializeTemplates(dataDir);

    expect(readFileSync(readme, "utf8")).toBe("USER EDIT — do not touch");
  } finally {
    cleanupDir(dataDir);
  }
});

test("is idempotent: a second call copies nothing and leaves files intact", () => {
  const dataDir = tmpDataDir("templates-idempotent");
  try {
    const first = materializeTemplates(dataDir);
    expect(first.copied.length).toBeGreaterThan(0);

    const readme = join(dataDir, "templates", "README.md");
    const before = readFileSync(readme, "utf8");

    const second = materializeTemplates(dataDir);
    expect(second.copied).toEqual([]);
    expect(readFileSync(readme, "utf8")).toBe(before);
  } finally {
    cleanupDir(dataDir);
  }
});

/**
 * `templates sync` classification, driven with a private mkdtemp source tree so
 * the assertions are deterministic (not coupled to the real starter kit). dest
 * is seeded with a byte-identical file (SAME), an edited file (DRIFTED), and a
 * MISSING file left absent.
 */
test("syncTemplates: adds MISSING, reports DRIFTED, and does NOT overwrite without confirm", async () => {
  const dataDir = tmpDataDir("templates-sync-classify");
  const sourceDir = tmpDataDir("templates-sync-src");
  try {
    writeFileSync(join(sourceDir, "missing.txt"), "SOURCE missing");
    writeFileSync(join(sourceDir, "same.txt"), "identical");
    mkdirSync(join(sourceDir, "nested"), { recursive: true });
    writeFileSync(join(sourceDir, "nested", "drift.txt"), "SOURCE new");

    const destRoot = join(dataDir, "templates");
    mkdirSync(join(destRoot, "nested"), { recursive: true });
    writeFileSync(join(destRoot, "same.txt"), "identical");
    writeFileSync(join(destRoot, "nested", "drift.txt"), "USER edit");

    const result = await syncTemplates(dataDir, { sourceDir, confirm: () => false });

    expect(result.added).toEqual(["missing.txt"]);
    expect(result.drifted).toEqual([join("nested", "drift.txt")]);
    expect(result.overwritten).toEqual([]);

    // MISSING was created from source
    expect(readFileSync(join(destRoot, "missing.txt"), "utf8")).toBe("SOURCE missing");
    // DRIFTED was reported, NOT clobbered
    expect(readFileSync(join(destRoot, "nested", "drift.txt"), "utf8")).toBe("USER edit");
    // SAME left untouched
    expect(readFileSync(join(destRoot, "same.txt"), "utf8")).toBe("identical");
  } finally {
    cleanupDir(dataDir);
    cleanupDir(sourceDir);
  }
});

test("syncTemplates: overwrites a DRIFTED file ONLY when confirm returns true (per-file)", async () => {
  const dataDir = tmpDataDir("templates-sync-confirm");
  const sourceDir = tmpDataDir("templates-sync-src2");
  try {
    writeFileSync(join(sourceDir, "a.txt"), "SOURCE A");
    writeFileSync(join(sourceDir, "b.txt"), "SOURCE B");
    const destRoot = join(dataDir, "templates");
    mkdirSync(destRoot, { recursive: true });
    writeFileSync(join(destRoot, "a.txt"), "USER A");
    writeFileSync(join(destRoot, "b.txt"), "USER B");

    // confirm only a.txt — b.txt must remain the user's copy
    const result = await syncTemplates(dataDir, { sourceDir, confirm: (rel) => rel === "a.txt" });

    expect(result.added).toEqual([]);
    expect([...result.drifted].sort()).toEqual(["a.txt", "b.txt"]);
    expect(result.overwritten).toEqual(["a.txt"]);
    expect(readFileSync(join(destRoot, "a.txt"), "utf8")).toBe("SOURCE A");
    expect(readFileSync(join(destRoot, "b.txt"), "utf8")).toBe("USER B");
  } finally {
    cleanupDir(dataDir);
    cleanupDir(sourceDir);
  }
});
