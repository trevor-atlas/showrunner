# @showrunner/starter-kit

The out-of-the-box Showrunner content. Six agent modules,
a shared gates library, the `poll` tool, ten blueprint modules, and ten skill
files — **all of it a replace-this surface**.

## What's in the box

```
src/models.ts               the replaceable model roster (edit ONE file to retarget every agent)
src/envelopes.ts            the six agents' output contracts
src/agents/                 the six doers: planner, builder, scout, reviewer, documenter, ship
src/gates/                  shared gates: testsPass, lintClean, matchesPlan, envelopeShape,
                            filesExist, reviewApproved (+ inputsDirFor / workspaceShell helpers)
src/blueprints/             the ten blueprint modules the skills wrap
src/blueprints/fake-pi/     scripted FakePi sessions for the CLI path (generated — see below)
src/tools/poll.ts           the poll tool (a pi extension; install like the skills)
skills/                     the ten skill files (install by copying into ~/.pi/agent/skills)
test/                       STARTER tests — replace them with yours
                            (they live at the repo root: test/starter-kit/)
```

## The mapping: skill → blueprint → agents & gates

| Skill dir (`skills/`) | Blueprint (`src/blueprints/`) | Agents | Gates | Reach for it when |
| --- | --- | --- | --- | --- |
| `prompt` | `prompt.ts` | planner (edit to pick who) | — | one agent, one prompt; `NAME` picks who |
| `scout` | `scout.ts` | scout | `envelopeShape` | read-only recon, nothing changes |
| `plan` | `plan.ts` | planner | — | the spec before any code |
| `build` | `build.ts` | builder | — | the plan already exists |
| `plan-build` | `plan_build.ts` | planner → builder → ship | `matchesPlan`; ship `require_approval` | small, well-understood work |
| `build-test` | `build_test.ts` | builder ⇄ builder | `testsPass`, `lintClean`; bounded fix loop | a suite to satisfy |
| `build-review` | `build_review.ts` | builder ⇄ reviewer | `reviewApproved`; bounded revise loop | "is this what was asked for" matters more than "does it run" |
| `plan-build-test` | `plan_build_test.ts` | plan → build → review → ship | `matchesPlan`, `testsPass`, `lintClean`, `reviewApproved`; ship `require_approval` | the standard chain |
| `document` | `document.ts` | documenter | `filesExist` | write up what just shipped |
| `everything` | `everything.ts` | plan → build → review → ship | all of the above; plan AND ship `require_approval`; heavier budgets | the work is real and its shape is not obvious |

Skill **names** use hyphens (`plan-build` — the Agent Skills standard allows only
lowercase a-z, 0-9, hyphens); blueprint **names/modules** use the underscores
(`plan_build`). The skill names are what pi's model sees;
the blueprint names are what the run loop records.

## The command gates (`testsPass`, `lintClean`)

The two command gates run REAL commands in the run's workspace (`ctx.cwd`).
They resolve their target instead of failing with an opaque exit-1:

- `lintClean()` — an explicit `command`/`tsconfig` option wins; otherwise the
  **nearest `tsconfig.json` up from the run cwd** runs as `bunx tsc -p <path> --noEmit`;
  otherwise the nearest `package.json`'s `"typecheck"` script runs as
  `bun run typecheck`; otherwise the gate **fails loudly** ("no tsconfig found
  at <path>").
- `testsPass()` — an explicit `command` wins; otherwise the nearest
  `package.json`'s `"test"` script runs as `bun run test`; otherwise any
  `*.test.ts`/`*.spec.ts` files under the run cwd run as `bun test`; otherwise
  the gate **fails loudly** ("no test target").

Both are replace-this: pass `{ command: "npm test" }` / `{ tsconfig }` /
`{ command: "bun run lint" }` per phase to point them at your project.

## Running the blueprints

`showrunner run` takes a blueprint **module path** (the CLI has no name registry
yet). The skills reference blueprint names; this README is how a name resolves
to a path:

```bash
showrunner run src/starter-kit/blueprints/scout.ts --prompt "map the auth flow"
showrunner run src/starter-kit/blueprints/plan_build_test.ts --prompt "add offline sync"
```

Each blueprint's phases have scripted FakePi sessions next to the module
(`src/blueprints/fake-pi/<phase-slug>.json`) — the TEST FIXTURE for the
scripted path (`SHOWRUNNER_FAKE=1`), not the runtime default. The server runs
the real pi binary by default (auto-detected on PATH). Regenerate the fixture
sessions after editing the fixture builders:

```bash
bun run gen:fixtures      # scripts/generate-fake-pi-sessions.ts
```

**`--prompt` is wired**: the spec's skill files pass the user's goal as
`showrunner run <blueprint> --prompt "<args>"`; the CLI forwards it through the
POST /runs body and the server renders it as a `[User request]` section at the
top of the composed first prompt (the agent's actual goal). It works today.

Real pi is the product default; real runs cost real tokens. The scripted
sessions exist so tests, CI, and token-free demos can pin the loop
(`SHOWRUNNER_FAKE=1`) — no spend, deterministic.

## The poll tool

`src/tools/poll.ts` is a pi **extension** that registers the `poll` tool
(pi's tool/extension format, docs/extensions.md): run a shell command repeatedly
until it exits 0 or its own timeout elapses — how `ship` watches CI. Install it
like the skills:

```bash
mkdir -p ~/.pi/agent/extensions
cp src/starter-kit/src/tools/poll.ts ~/.pi/agent/extensions/
```

Agents that list `"poll"` in their `tools` (the ship agent does) can call it.
Its runtime imports (`@earendil-works/pi-coding-agent`, `typebox`) resolve inside
pi's extension loader; they are devDependencies here only so the kit can
typecheck the file.

## Installing the skills

Copy or symlink the skill directories into a pi skill location (docs/skills.md):

```bash
mkdir -p ~/.pi/agent/skills
cp -R src/starter-kit/skills/* ~/.pi/agent/skills/
# or:  ln -s $PWD/src/starter-kit/skills/* ~/.pi/agent/skills/
# or:  add the directory via settings.json ("skills" array) / --skill
```

Pi loads only each skill's `description` at startup — make yours specific; the
full SKILL.md loads on demand (progressive disclosure).

## The replace-this doctrine

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
| the shipped tests | `test/starter-kit/` — they prove the machinery, not your project |

## Dev

The kit is part of the one-package repo (no own `package.json`/`tsconfig`), so
the root commands drive it:

```bash
bun test test/starter-kit/     # the kit's tests: fixtures, gates, skills
bun run typecheck              # one tsconfig for the whole repo
bun run gen:fixtures           # regenerate src/starter-kit/blueprints/fake-pi/*
```

Notes:

- Tests build scratch dirs under the OS tmpdir and remove them on teardown —
  no residue in the repo.
