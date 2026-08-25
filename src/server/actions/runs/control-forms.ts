import * as s from "remix/data-schema";
import * as f from "remix/data-schema/form-data";
import type { Issue } from "remix/data-schema";

import type { ControlError } from "../../ui/pause-menu.tsx";

/**
 * The control verbs' data-schema validation (the UI does not import
 * zod; `remix/data-schema` is the framework's own validator) and the
 * ControlError builders the controllers share.
 *
 * Validation contract: steer `message` required (non-blank); override
 * `gate` + `reason` both required (non-blank); the confirm forms (restart /
 * fail / approve) and resume carry NO data — the confirm IS the action, so
 * they need no schema. Failures re-render the page with the errors inline on
 * the form that submitted them (no silent drop).
 */

/** Non-blank required string (missing OR whitespace-only fails). */
function requiredText(message: string) {
  return s
    .string()
    .transform((value: string) => value.trim())
    .refine((value: string) => value.length > 0, message);
}

/** The steer form: `message` → POST /runs/:runId/steer. */
export const steerFormSchema = f.object({
  message: f.field(requiredText("steer message is required")),
});

/** The override form: `gate` + `reason` → POST .../phases/:phase/override. */
export const overrideFormSchema = f.object({
  gate: f.field(requiredText("gate is required")),
  reason: f.field(requiredText("reason is required")),
});

/** A data-schema validation failure as a ControlError on the submitted form. */
export function validationError(
  verb: ControlError["verb"],
  issues: readonly Issue[],
): ControlError {
  const fields: Record<string, string> = {};
  for (const issue of issues) {
    const key = typeof issue.path?.[0] === "string" ? issue.path[0] : "form";
    if (fields[key] === undefined) {
      fields[key] = issue.message === "Expected string" ? `${key} is required` : issue.message;
    }
  }
  const summary = Object.values(fields).join("; ");
  return { verb, message: `check the ${verb} form — ${summary}`, fields };
}

/** A server 409/4xx (ApiError) surfaced on the form that submitted it. */
export function apiControlError(verb: ControlError["verb"], err: { status: number; message: string }): ControlError {
  return { verb, message: `${verb} failed (${err.status}): ${err.message}` };
}
