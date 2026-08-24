/**
 * poll — a wait-with-timeout tool for pi ("Waits": the harness does
 * not manage external waits; the agent's poll tool carries its own timeout
 * and the harness just observes the long tool call).
 *
 * The ship agent uses it to watch CI: run a status command repeatedly until
 * it exits 0 or the timeout elapses, then report what the last check saw.
 *
 * ── Install ───────────────────────────────────────────────────────────────
 * pi's tool/extension format (docs/extensions.md): an extension module that
 * registers the tool. Install like the skills — copy or symlink this file
 * into ~/.pi/agent/extensions/ (global) or.pi/extensions/ (project), or add
 * it via settings.json ("extensions" array). Once loaded, agents that list
 * "poll" in their tools can call it.
 *
 *   mkdir -p ~/.pi/agent/extensions
 *   cp packages/starter-kit/src/tools/poll.ts ~/.pi/agent/extensions/
 *   pi -e ~/.pi/agent/extensions/poll.ts   # verify it loads
 *
 * Runtime imports (`@earendil-works/pi-coding-agent`, `typebox`) resolve
 * inside pi's extension loader; they are devDependencies here only so the
 * starter kit can typecheck the file.
 *
 * ── Replace-this ──────────────────────────────────────────────────────────
 * The default command assumes a git-based CI check. Change `defaultCommand`
 * to your provider's status command, or leave the command to the agent's
 * call arguments.
 */
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** the status command poll runs when the agent does not pass one */
const DEFAULT_COMMAND = "git status --porcelain && echo 'working tree checked'";

const POLL_PARAMS = Type.Object({
  /** shell command to run repeatedly; exit 0 means "done" */
  command: Type.String({
    description: "Shell command to run on every poll. Exit code 0 means the condition is met; any other exit keeps polling.",
  }),
  /** ms between checks (default 5000) */
  interval_ms: Type.Optional(Type.Number({ description: "Milliseconds between checks. Default 5000." })),
  /** total ms to keep polling before giving up (default 300000 = 5 min) */
  timeout_ms: Type.Optional(Type.Number({ description: "Total milliseconds to poll before giving up. Default 300000." })),
  /** human note so the model can explain why it is waiting */
  note: Type.Optional(Type.String({ description: "Optional note: what the model is waiting for (e.g. 'CI on PR #12')." })),
});

interface PollParams {
  command: string;
  interval_ms?: number;
  timeout_ms?: number;
  note?: string;
}

/** Run one shell command; resolve { code, stdout, stderr } (never rejects). */
function runOnce(command: string, signal: AbortSignal | undefined): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (code: number): void => {
      if (done) return;
      done = true;
      resolve({ code, stdout, stderr });
    };
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => {
      stderr += `\nspawn error: ${err.message}`;
      finish(1);
    });
    child.on("close", (code) => finish(code ?? 1));
    signal?.addEventListener("abort", () => {
      child.kill("SIGTERM");
    });
  });
}

export default function pollExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "poll",
    label: "Poll",
    description:
      "Run a shell command repeatedly until it exits 0 or the timeout elapses. Use for waiting on external state — CI status, a server coming up, a file appearing — instead of sleeping once and hoping.",
    promptSnippet: "Use poll to wait for an external condition (CI, server, file) with its own timeout.",
    promptGuidelines: [
      "Use poll when the current step depends on an external condition that takes time (CI checks, deployments, servers).",
      "Give poll a command that exits 0 exactly when the condition is met; keep timeout_ms proportional to how long the condition can legitimately take.",
      "When poll times out, do not claim the condition passed — report the last observed state honestly.",
    ],
    parameters: POLL_PARAMS,
    executionMode: "sequential",
    async execute(_toolCallId, params: PollParams, signal, onUpdate) {
      const command = params.command || DEFAULT_COMMAND;
      const intervalMs = params.interval_ms ?? 5000;
      const timeoutMs = params.timeout_ms ?? 300_000;
      const deadline = Date.now() + timeoutMs;
      const started = new Date().toISOString();
      let attempt = 0;
      let last: { code: number; stdout: string; stderr: string } = { code: 1, stdout: "", stderr: "" };

      for (;;) {
        attempt += 1;
        last = await runOnce(command, signal);
        if (last.code === 0) {
          const content = [
            `poll: condition met on attempt ${attempt}`,
            `  command: ${command}`,
            `  started: ${started}`,
            last.stdout.trim() !== "" ? `  stdout:\n${last.stdout.trim()}` : "",
            last.stderr.trim() !== "" ? `  stderr:\n${last.stderr.trim()}` : "",
          ]
            .filter((l) => l !== "")
            .join("\n");
          return { content: [{ type: "text", text: content }], details: { met: true, attempts: attempt } };
        }
        if (Date.now() >= deadline) {
          const content = [
            `poll: timed out after ${timeoutMs}ms (${attempt} attempts) — condition not met`,
            `  command: ${command}`,
            `  last exit code: ${last.code}`,
            last.stdout.trim() !== "" ? `  last stdout:\n${last.stdout.trim().slice(0, 4000)}` : "",
            last.stderr.trim() !== "" ? `  last stderr:\n${last.stderr.trim().slice(0, 4000)}` : "",
          ]
            .filter((l) => l !== "")
            .join("\n");
          return { content: [{ type: "text", text: content }], details: { met: false, attempts: attempt } };
        }
        onUpdate?.({
          content: [{ type: "text", text: `poll attempt ${attempt}: exit ${last.code} — waiting (${Math.round((deadline - Date.now()) / 1000)}s left)` }],
          details: { met: false, attempts: attempt },
        });
        await new Promise((r) => setTimeout(r, intervalMs));
        if (signal?.aborted) {
          return {
            content: [{ type: "text", text: "poll: aborted by the run" }],
            details: { met: false, aborted: true },
            isError: true,
          };
        }
      }
    },
  });
}
