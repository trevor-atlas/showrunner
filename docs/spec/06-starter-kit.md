# Showrunner — Specification · Starter kit

> Part of the [Showrunner specification](README.md) — section §15
> [index](README.md) · [01-overview](01-overview.md) · [02-core](02-core-sdk.md) · [03-data](03-data-and-events.md) · [04-daemon](04-daemon.md) · [05-ui](05-ui-dashboard.md) · [06-starter](06-starter-kit.md) · [07-tests](07-testing-and-rollout.md) · [08-verify](08-verification-record.md)

## 15 · Starter kit & skill files

`src/starter-kit` ships: six agent modules (§3.3 shape), a shared gates library (`testsPass`, `lintClean`, `matchesPlan`, `envelopeShape`, …), the `poll` tool, and ten skill files wrapping blueprints.

**Skill file mechanics** (per pi's skill implementation — `docs/skills.md`, Agent Skills standard):

- One directory per skill, `src/starter-kit/skills/<name>/SKILL.md`, e.g. `plan_build/SKILL.md`.
- Frontmatter: `name` (lowercase, hyphens, ≤64 chars) and `description` (specific — it is the *only* thing pi's model sees until the skill loads; a poor description means the skill never fires).
- Body: instructions that resolve the user's `{prompt}` argument and submit a run, e.g. "run `showrunner run plan_build --prompt \"<args>\"`". The skill is the human-facing trigger; the blueprint is the machine-facing config.
- Progressive disclosure: only descriptions are in context at startup; the full SKILL.md loads on demand.
- Installation for use: copy or symlink `src/starter-kit/skills/*` into `~/.pi/agent/skills/`, or add the directory via settings (`skills` array) / `--skill`.
- **The replace-this doctrine**: the six agents describe a demo app, the roster names models that were good the week it shipped, and the skills wrap starter blueprints — all meant to be replaced by a small edit in an obvious file.


