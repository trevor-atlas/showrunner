import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installSkills, resolveSkillsDir } from "../../src/server/services/skills.ts";
import { materializeTemplates } from "../../src/server/services/templates.ts";

const cleanups: string[] = [];
afterEach(() => {
  for (const d of cleanups.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

test("installSkills copies the starter-kit skill into the global skills dir, one dir per skill", () => {
  const skillsDir = scratch("sr-skills-");
  const result = installSkills({ skillsDir });

  expect(result.skillsDir).toBe(skillsDir);
  expect(result.installed).toContain("showrunner");
  const skillFile = join(skillsDir, "showrunner", "SKILL.md");
  expect(existsSync(skillFile)).toBe(true);
  // the SKILL.md carries the operator framing (frontmatter name)
  expect(readFileSync(skillFile, "utf8")).toContain("name: showrunner");
});

test("installSkills is copy-if-absent: a second call skips, --force overwrites", () => {
  const skillsDir = scratch("sr-skills-");
  installSkills({ skillsDir });

  // a user edit to the installed copy
  const skillFile = join(skillsDir, "showrunner", "SKILL.md");
  writeFileSync(skillFile, "edited");

  const second = installSkills({ skillsDir });
  expect(second.installed).not.toContain("showrunner");
  expect(second.skipped).toContain("showrunner");
  expect(readFileSync(skillFile, "utf8")).toBe("edited"); // preserved

  const forced = installSkills({ skillsDir, force: true });
  expect(forced.installed).toContain("showrunner");
  expect(readFileSync(skillFile, "utf8")).toContain("name: showrunner"); // overwritten
});

test("resolveSkillsDir honors SHOWRUNNER_SKILLS_DIR, else defaults under ~/.agents/skills", () => {
  expect(resolveSkillsDir({ SHOWRUNNER_SKILLS_DIR: "/tmp/x" })).toBe("/tmp/x");
  expect(resolveSkillsDir({})).toMatch(/\.agents\/skills$/);
});

test("materializeTemplates does NOT put skills in the data dir (skills install globally, not here)", () => {
  const dataDir = scratch("sr-data-");
  materializeTemplates(dataDir);
  expect(existsSync(join(dataDir, "templates", "skills"))).toBe(false);
  // sanity: the runtime content IS materialized
  expect(existsSync(join(dataDir, "templates", "blueprints"))).toBe(true);
});
