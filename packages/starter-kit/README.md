# @showrunner/starter-kit

The out-of-the-box Showrunner content (spec §15, PLAN §14). Six agent modules,
a shared gates library, the `poll` tool, ten blueprint modules, and ten skill
files — **all of it a replace-this surface**.

## What's in the box

```
src/models.ts               the replaceable model roster (edit ONE file to retarget every agent)
src/envelopes.ts            the six agents' output contracts (ADR-0002)
src/agents/                 the six doers: planner, builder, scout, reviewer, documenter, ship
src/gates/                  shared gates: testsPass, lintClean, matchesPlan, envelopeShape,
                            filesExist, reviewApproved (+ inputsDirFor / workspaceShell helpers)
src/blueprints/             the ten blueprint modules the skills wrap
src/blueprints/fake-pi/     scripted FakePi sessions for the CLI path (generated — see below)
src/tools/poll.ts           the poll tool (a pi extension; install like the skills)
skills/                     the ten skill files (install by copying into ~/.pi/agent/skills)
test/                       STARTER tests — replace them with yours (spec §17)
```

## The mapping: skill → blueprint → agents & gates

| Skill dir (`skills/`) | Blueprint (`src/blueprints/`) | Agents | Gates | Reach for it when |
| --- | --- | --- | --- | --- |
| `prompt` | `prompt.ts` | planner (edit to pick who) | — | one agent, one prompt; `NAME` picks who |
| `scout` | `scout.ts` | scout | `envelopeShape` | read-only recon, nothing changes |
| `plan` | `plan.ts` | planner | `envelopeShape` | the spec before any code |
| `build` | `build.ts` | builder | `envelopeShape` | the plan already exists |
| `plan-build` | `plan_build.ts` | planner → builder → ship | `envelopeShape`, `matchesPlan`; ship `require_approval` | small, well-understood work |
| `build-test` | `build_test.ts` | builder ⇄ builder | `testsPass`, `lintClean`; bounded fix loop | a suite to satisfy |
| `build-review` | `build_review.ts` | builder ⇄ reviewer | `envelopeShape`, `reviewApproved`; bounded revise loop | "is this what was asked for" matters more than "does it run" |
| `plan-build-test` | `plan_build_test.ts` | plan → build → review → ship | `envelopeShape`, `matchesPlan`, `testsPass`, `lintClean`, `reviewApproved`; ship `require_approval` | the standard chain |
| `document` | `document.ts` | documenter | `envelopeShape`, `filesExist` | write up what just shipped |
| `everything` | `everything.ts` | plan → build → review → ship | all of the above; plan AND ship `require_approval`; heavier budgets | the work is real and its shape is not obvious |

Skill **names** use hyphens (`plan-build` — the Agent Skills standard allows only
lowercase a-z, 0-9, hyphens); blueprint **names/modules** use the underscores from
PLAN §14's table (`plan_build`). The skill names are what pi's model sees;
the blueprint names are what the run loop records.

## Running the blueprints

`showrunner run` takes a blueprint **module path** (the CLI has no name registry
yet). The skills reference blueprint names; this README is how a name resolves
to a path:

```bash
showrunner run packages/starter-kit/src/blueprints/scout.ts --prompt "map the auth flow"
showrunner run packages/starter-kit/src/blueprints/plan_build_test.ts --prompt "add offline sync"
```

Each blueprint's phases have scripted FakePi sessions next to the module
(`src/blueprints/fake-pi/<phase-slug>.json`), so the current daemon build (FakePi
only) runs them out of the box. Regenerate those sessions after editing the
fixture builders:

```bash
bun --cwd packages/starter-kit gen:fixtures      # scripts/generate-fake-pi-sessions.ts
```

**A note on `--prompt`**: the spec's skill files pass the user's goal as
`showrunner run <blueprint> --prompt "<args>"`. The current CLI parses
`--prompt` but does not forward it to the daemon yet — the phase goal lives in
the blueprint (or you steer the run). That wiring is an open question for the
CLI/daemon owner; the skills keep the spec form so the goal lands the day it
ships.

Real-pi runs (env-gated smokes) are the T13 capstone — no token spend in this
package.

## The poll tool

`src/tools/poll.ts` is a pi **extension** that registers the `poll` tool
(pi's tool/extension format, docs/extensions.md): run a shell command repeatedly
until it exits 0 or its own timeout elapses — how `ship` watches CI. Install it
like the skills:

```bash
mkdir -p ~/.pi/agent/extensions
cp packages/starter-kit/src/tools/poll.ts ~/.pi/agent/extensions/
```

Agents that list `"poll"` in their `tools` (the ship agent does) can call it.
Its runtime imports (`@earendil-works/pi-coding-agent`, `typebox`) resolve inside
pi's extension loader; they are devDependencies here only so the kit can
typecheck the file.

## Installing the skills

Copy or symlink the skill directories into a pi skill location (docs/skills.md):

```bash
mkdir -p ~/.pi/agent/skills
cp -R packages/starter-kit/skills/* ~/.pi/agent/skills/
# or:  ln -s $PWD/packages/starter-kit/skills/* ~/.pi/agent/skills/
# or:  add the directory via settings.json ("skills" array) / --skill
```

Pi loads only each skill's `description` at startup — make yours specific; the
full SKILL.md loads on demand (progressive disclosure).

## The replace-this doctrine (PLAN §14)

Everything in this package is a **starter** — the tests it ships are not your
tests, the prompts describe a demo app not your domain, and the roster names
models that were good the week it shipped. Each replacement is a small edit in
an obvious file:

| To replace… | Edit… |
| --- | --- |
| the models agents use | `src/models.ts` (one object; every agent follows) |
| what an agent does | its file in `src/agents/` (name, prompt, tools, context) |
| the output contracts | `src/envelopes.ts` (the gates and prompts follow) |
| the gates' commands | the defaults in `src/gates/index.ts` or per-phase options |
| a blueprint's wiring | its file in `src/blueprints/` (phases, gates, budgets, `on_fail`, `require_approval`) |
| the shipped tests | `test/` — they prove the machinery (spec §17 fixtures), not your project |

## Dev

```bash
bun install --cwd packages/starter-kit
bun --cwd packages/starter-kit test          # 23 starter tests: fixtures, gates, skills
bunx tsc -p packages/starter-kit/tsconfig.json
```

Notes:

- The daemon is imported **relatively** in the tests (`../../daemon/src/...`), not
  as a package dep — bun 1.4 cannot resolve a `file:` dep's own `file:` deps
  (same reason the CLI imports the daemon relatively).
- Tests build scratch dirs under the OS tmpdir and remove them on teardown —
  no residue in the repo.
