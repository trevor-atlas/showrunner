import { css } from "remix/ui";
import type { Handle } from "remix/ui";

import { routes } from "../routes.ts";

/**
 * The pause menu (`PauseMenu` + `SteerForm` /
 * `OverrideForm`): the control surface shown on run detail when the run is
 * PAUSED. One form per action; every form posts to a remix POST route (which
 * calls the daemon endpoint through the server-side client — the
 * browser never talks to the daemon) and re-renders/redirects from
 * daemon state. No optimistic mutation: nothing here flips client state.
 *
 * Which actions render comes from the daemon's own pause viewer (
 * `/runs/:id/pause`): the `actions` array is `effectiveMenu(info)` per pause
 * kind (approval → approve+steer+fail; budget_exhausted →
 * steer+override+restart_fresh+fail; guard/blocked/hook → steer+restart_fresh
 * +fail). A form that carries a pending error ALSO renders (defensive rule)
 * so a 409/validation failure is never dropped silently — the error renders
 * inline on the form that was submitted.
 *
 * Resume (interrupted runs) is a separate HEADER action and is NOT
 * part of this menu.
 */

/** The six control verbs — one remix POST route each. */
export type ControlVerb = "steer" | "override" | "restart" | "fail" | "approve" | "resume";

/** A control failure surfaced on the form that submitted it. `fields` holds
 * data-schema validation messages (keyed by field name); `message` is the
 * top-level text — an ApiError's status+message for daemon 409/4xx, or a
 * validation summary. */
export interface ControlError {
  verb: ControlVerb;
  message: string;
  fields?: Record<string, string>;
}

export interface PauseMenuProps {
  runId: string;
  /** the paused phase's name (the pause viewer's `phase`) */
  phase: string;
  /** the pause kind (approval | budget_exhausted | guard_exhausted | blocked | hook_failed) */
  kind: string;
  /** the pause reason (the run_status event's reason) */
  reason: string | null;
  /** the daemon's effective menu — which forms to render */
  actions: readonly string[];
  /** steers queued while paused (delivered on continuation) */
  queuedSteers: readonly string[];
  /** the FAILED gate names on the paused phase — the override select options */
  overrideGates: readonly string[];
  /** the pending control error (from the last failed POST), or null */
  error: ControlError | null;
}

/** Render the pause menu for a paused run. */
export function PauseMenu(handle: Handle<PauseMenuProps>) {
  return () => {
    const { runId, phase, kind, reason, actions, queuedSteers, overrideGates, error } = handle.props;
    const hasActions = actions.length > 0;
    return (
      <section data-pause-menu data-pause-kind={kind} data-pause-phase={phase} mix={menuStyle} role="region" aria-label="pause menu">
        <header mix={menuHeaderStyle}>
          <span mix={pauseGlyphStyle}>⏸ paused</span>
          <span mix={menuTitleStyle}>
            — {phase}
            <span mix={mutedStyle}> ({kind})</span>
          </span>
        </header>
        {reason !== null && reason !== "" ? (
          <p mix={reasonStyle} data-pause-reason>
            {reason}
          </p>
        ) : null}
        {queuedSteers.length > 0 ? (
          <p mix={queuedStyle} data-queued-steers>
            {queuedSteers.length} queued steer{queuedSteers.length === 1 ? "" : "s"}:{" "}
            {queuedSteers.map((s) => `“${s}”`).join(", ")} — delivered on continuation
          </p>
        ) : null}

        {!hasActions && error === null ? (
          <p mix={noteStyle} data-pause-note>
            the daemon has no control handle for this pause (restarted?) — no actions available
          </p>
        ) : null}

        <div mix={formsStyle}>
          {hasActions || error?.verb === "steer" ? (
            <SteerForm runId={runId} error={error?.verb === "steer" ? error : null} />
          ) : null}
          {hasActions && actions.includes("override") ? (
            <OverrideForm
              runId={runId}
              phase={phase}
              gates={overrideGates}
              error={error?.verb === "override" ? error : null}
            />
          ) : null}
          {hasActions && actions.includes("restart_fresh") ? (
            <ConfirmForm
              dataForm="restart"
              label="restart phase fresh"
              hint="new pi session, same config (confirm)"
              action={routes.runs.phases.restart.href({ runId, phase })}
              error={error?.verb === "restart" ? error : null}
            />
          ) : null}
          {hasActions && actions.includes("fail") ? (
            <ConfirmForm
              dataForm="fail"
              label="fail run"
              hint="kill the run's children (confirm)"
              action={routes.runs.fail.href({ runId })}
              error={error?.verb === "fail" ? error : null}
            />
          ) : null}
          {hasActions && actions.includes("approve") ? (
            <ConfirmForm
              dataForm="approve"
              label="approve"
              hint="approval granted — the phase proceeds to spawn"
              action={routes.runs.approve.href({ runId })}
              error={error?.verb === "approve" ? error : null}
            />
          ) : null}
        </div>
      </section>
    );
  };
}

/** The audited steer form: message → POST /runs/:runId/steer (the
 * daemon's run-keyed steer — on a paused run the message is queued and the
 * run stays paused; delivery lands with the continuation machinery).
 * `message` is validated with data-schema (required, non-blank). */
function SteerForm(handle: Handle<{ runId: string; error: ControlError | null }>) {
  return () => {
    const { runId, error } = handle.props;
    const messageError = error?.fields?.["message"];
    return (
      <form
        method="post"
        action={routes.runs.steer.href({ runId })}
        data-form="steer"
        mix={formStyle}
      >
        <label mix={formLabelStyle}>
          <span mix={verbStyle}>steer</span>
          <textarea
            name="message"
            rows={2}
            placeholder="send a corrective instruction… (delivered between turns)"
            mix={textareaStyle}
          />
        </label>
        <div mix={rowActionsStyle}>
          <button type="submit" mix={buttonStyle}>
            send
          </button>
          {messageError !== undefined ? (
            <span mix={fieldErrorStyle} data-field-error="message">
              {messageError}
            </span>
          ) : null}
        </div>
        <FormError error={error} />
      </form>
    );
  };
}

/** The audited override form: gate select + reason →
 * POST /runs/:runId/phases/:phase/override. Both fields validate with
 * data-schema (required). The gate options are the FAILED gates on the paused
 * phase (the pause's override targets). */
function OverrideForm(
  handle: Handle<{ runId: string; phase: string; gates: readonly string[]; error: ControlError | null }>,
) {
  return () => {
    const { runId, phase, gates, error } = handle.props;
    const gateError = error?.fields?.["gate"];
    const reasonError = error?.fields?.["reason"];
    return (
      <form
        method="post"
        action={routes.runs.phases.override.href({ runId, phase })}
        data-form="override"
        mix={formStyle}
      >
        <div mix={overrideRowStyle}>
          <span mix={verbStyle}>override gate</span>
          <select name="gate" mix={selectStyle}>
            {gates.length === 0 ? <option value="">no failed gates</option> : null}
            {gates.map((gate) => (
              <option key={gate} value={gate}>
                {gate}
              </option>
            ))}
          </select>
          <input name="reason" type="text" placeholder="reason (audited)" mix={reasonInputStyle} />
          <button type="submit" mix={buttonStyle}>
            go
          </button>
        </div>
        <div mix={fieldErrorsRowStyle}>
          {gateError !== undefined ? (
            <span mix={fieldErrorStyle} data-field-error="gate">
              {gateError}
            </span>
          ) : null}
          {reasonError !== undefined ? (
            <span mix={fieldErrorStyle} data-field-error="reason">
              {reasonError}
            </span>
          ) : null}
        </div>
        <FormError error={error} />
      </form>
    );
  };
}

/** A no-data confirm form (restart phase fresh / fail run / approve): the
 * button click IS the confirmation — the confirm form carries no fields. */
function ConfirmForm(
  handle: Handle<{
    dataForm: ControlVerb;
    label: string;
    hint: string;
    action: string;
    error: ControlError | null;
  }>,
) {
  return () => {
    const { dataForm, label, hint, action, error } = handle.props;
    return (
      <form method="post" action={action} data-form={dataForm} mix={formStyle}>
        <div mix={rowActionsStyle}>
          <button type="submit" mix={[buttonStyle, dangerButtonStyle]}>
            {label}
          </button>
          <span mix={hintStyle}>{hint}</span>
        </div>
        <FormError error={error} />
      </form>
    );
  };
}

/** The inline error block for one form (a failed action surfaces the
 * error from ApiError.status/message on the form — no silent drop). */
function FormError(handle: Handle<{ error: ControlError | null }>) {
  return () => {
    const { error } = handle.props;
    if (error === null) return null;
    return (
      <p mix={formErrorStyle} data-form-error data-error-for={error.verb} role="alert">
        {error.message}
      </p>
    );
  };
}

const menuStyle = css({
  display: "grid",
  gap: "0.6rem",
  padding: "0.9rem 1rem",
  border: "1px solid var(--amber-border)",
  borderRadius: "10px",
  background: "var(--amber-soft-faintest)",
});

const menuHeaderStyle = css({
  display: "flex",
  alignItems: "baseline",
  gap: "0.4rem",
  flexWrap: "wrap",
});

const pauseGlyphStyle = css({
  color: "var(--status-interrupted)",
  fontWeight: 800,
  fontSize: "var(--font-size-md)",
});

const menuTitleStyle = css({
  fontWeight: 700,
  fontSize: "var(--font-size-md)",
  color: "var(--foreground)",
});

const mutedStyle = css({
  color: "var(--muted-foreground)",
  fontWeight: 500,
  fontSize: "var(--font-size-sm)",
});

const reasonStyle = css({
  margin: 0,
  fontSize: "var(--font-size-sm)",
  color: "var(--amber-ink)",
  fontFamily: "var(--font-mono)",
});

const queuedStyle = css({
  margin: 0,
  fontSize: "var(--font-size-sm)",
  color: "var(--accent-violet)",
  fontFamily: "var(--font-mono)",
});

const noteStyle = css({
  margin: 0,
  fontSize: "var(--font-size-sm)",
  color: "var(--status-paused)",
});

const formsStyle = css({
  display: "grid",
  gap: "0.7rem",
});

const formStyle = css({
  display: "grid",
  gap: "0.35rem",
  padding: "0.55rem 0.7rem",
  border: "1px solid var(--border)",
  borderRadius: "8px",
  background: "var(--card)",
});

const formLabelStyle = css({
  display: "grid",
  gap: "0.25rem",
});

const verbStyle = css({
  fontSize: "var(--font-size-xs)",
  fontWeight: 800,
  textTransform: "lowercase",
  letterSpacing: "0.06em",
  color: "var(--muted-foreground)",
});

const textareaStyle = css({
  font: "inherit",
  fontSize: "var(--font-size-sm)",
  padding: "0.4rem 0.5rem",
  border: "1px solid var(--input)",
  borderRadius: "6px",
  resize: "vertical",
  minHeight: "2.6rem",
  fontFamily: "var(--font-mono)",
});

const rowActionsStyle = css({
  display: "flex",
  alignItems: "center",
  gap: "0.6rem",
  flexWrap: "wrap",
});

const overrideRowStyle = css({
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  flexWrap: "wrap",
});

const selectStyle = css({
  font: "inherit",
  fontSize: "var(--font-size-sm)",
  padding: "3px 6px",
  borderRadius: "6px",
  border: "1px solid var(--input)",
  background: "var(--card)",
  color: "var(--foreground)",
});

const reasonInputStyle = css({
  flex: "1 1 10rem",
  font: "inherit",
  fontSize: "var(--font-size-sm)",
  padding: "3px 8px",
  borderRadius: "6px",
  border: "1px solid var(--input)",
  background: "var(--card)",
  color: "var(--foreground)",
});

const fieldErrorsRowStyle = css({
  display: "flex",
  gap: "0.6rem",
  flexWrap: "wrap",
});

const fieldErrorStyle = css({
  fontSize: "var(--font-size-xs)",
  color: "var(--status-failed)",
  fontWeight: 600,
});

const buttonStyle = css({
  appearance: "none",
  font: "inherit",
  fontSize: "var(--font-size-sm)",
  fontWeight: 700,
  padding: "3px 12px",
  borderRadius: "999px",
  border: "1px solid var(--input)",
  background: "var(--card)",
  color: "var(--foreground)",
  cursor: "pointer",
  "&:hover": {
    background: "var(--secondary)",
  },
});

const dangerButtonStyle = css({
  color: "var(--status-failed)",
  borderColor: "var(--danger-border)",
  "&:hover": {
    background: "var(--status-failed-soft-hover)",
  },
});

const hintStyle = css({
  fontSize: "var(--font-size-xs)",
  color: "var(--muted-foreground)",
});

const formErrorStyle = css({
  margin: 0,
  fontSize: "var(--font-size-sm)",
  color: "var(--status-failed)",
  fontWeight: 600,
  fontFamily: "var(--font-mono)",
});
