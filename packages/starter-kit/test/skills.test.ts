import { afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Skill file validation (spec §15, pi docs/skills.md — Agent Skills standard):
 * one dir per skill, SKILL.md with frontmatter `name` (lowercase-hyphens,
 * ≤64 chars) and a specific `description` (the only thing pi's model sees
 * until the skill loads), and a body that submits a run via the CLI.
 *
 * The installability check copies the skills into a SCRATCH dir shaped like
 * ~/.pi/agent/skills/ and re-parses them there — nothing is installed into
 * the real ~/.pi/agent/skills.
 */

const skillsRoot = join(import.meta.dir, "..", "skills");

interface SkillDoc {
  dir: string;
  name: string;
  description: string;
  body: string;
}

function parseFrontmatter(text: string): { name: string; description: string; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  expect(m, "SKILL.md must start with --- frontmatter ---").not.toBeNull();
  const fm = m![1]!;
  const body = m![2]!.trim();
  const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? "";
  const description = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "";
  return { name, description, body };
}

function readSkills(): SkillDoc[] {
  const dirs = readdirSync(skillsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  return dirs.map((dir) => {
    const file = join(skillsRoot, dir, "SKILL.md");
    expect(existsSync(file), `skill ${dir} must have a SKILL.md`).toBe(true);
    const { name, description, body } = parseFrontmatter(readFileSync(file, "utf8"));
    return { dir, name, description, body };
  });
}

const cleanups: string[] = [];
afterEach(() => {
  for (const d of cleanups.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("the starter kit ships exactly the ten skills from PLAN §14's table", () => {
  const skills = readSkills();
  expect(skills.map((s) => s.dir)).toEqual([
    "build",
    "build-review",
    "build-test",
    "document",
    "everything",
    "plan",
    "plan-build",
    "plan-build-test",
    "prompt",
    "scout",
  ]);
});

test("every skill's frontmatter is valid per the Agent Skills standard (name, description)", () => {
  for (const s of readSkills()) {
    // name: lowercase a-z 0-9 hyphens only, 1..64 chars, no edge hyphens
    expect(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(s.name), `${s.dir}: name "${s.name}" must be lowercase-hyphens`).toBe(true);
    expect(s.name.length, `${s.dir}: name ≤ 64 chars`).toBeLessThanOrEqual(64);
    // description: required, specific (pi loads nothing else until the skill loads)
    expect(s.description.length, `${s.dir}: description required and specific`).toBeGreaterThanOrEqual(40);
    expect(s.description, `${s.dir}: description must not be a single generic word`).not.toBe(s.name);
    // body: instructs submitting a run via the CLI, and names a real blueprint
    expect(s.body, `${s.dir}: body must instruct a showrunner run`).toContain("showrunner run");
  }
});

test("every skill's blueprint name resolves to a real starter blueprint module", () => {
  const blueprintsDir = join(import.meta.dir, "..", "src", "blueprints");
  const blueprintFiles = new Set(readdirSync(blueprintsDir).filter((f) => f.endsWith(".ts") && f !== "index.ts"));
  // skill → blueprint name (PLAN §14 table); name → module file
  const moduleFor: Record<string, string> = {
    prompt: "prompt.ts",
    scout: "scout.ts",
    plan: "plan.ts",
    build: "build.ts",
    "plan-build": "plan_build.ts",
    "build-test": "build_test.ts",
    "build-review": "build_review.ts",
    "plan-build-test": "plan_build_test.ts",
    document: "document.ts",
    everything: "everything.ts",
  };
  for (const s of readSkills()) {
    const file = moduleFor[s.dir];
    expect(file, `${s.dir}: skill has no blueprint mapping`).toBeTruthy();
    expect(blueprintFiles.has(file!), `${s.dir}: blueprint module ${file} must exist`).toBe(true);
  }
});

test("skills are installable: copying them into a scratch ~/.pi/agent/skills-shaped dir yields the same layout and parseable frontmatter", () => {
  const scratchRoot = mkdtempSync(join(tmpdir(), "showrunner-skills-install-"));
  cleanups.push(scratchRoot);
  // shape it like ~/.pi/agent/skills (one dir per skill, SKILL.md inside)
  const agentSkills = join(scratchRoot, "pi", "agent", "skills");
  mkdirSync(agentSkills, { recursive: true });
  cpSync(skillsRoot, agentSkills, { recursive: true });

  const installed = readdirSync(agentSkills).filter((d) => d !== ".DS_Store").sort();
  expect(installed.length).toBe(10);
  for (const dir of installed) {
    const text = readFileSync(join(agentSkills, dir, "SKILL.md"), "utf8");
    const { name, description, body } = parseFrontmatter(text);
    expect(name).toBe(dir); // dir name == skill name (the standard's recommendation)
    expect(description.length).toBeGreaterThan(0);
    expect(body).toContain("showrunner run");
  }
});
