import { findingSchema } from "../review/finding.ts";
import { ok, type Tool, type ToolCtx } from "./types.ts";

/**
 * The only path by which a finding enters the pipeline. Free-text findings in the model's
 * prose are ignored by design: everything downstream (dedupe, verify, render, eval scoring)
 * needs `file:line`, and a schema is the only way to actually get it.
 */
export const reportFindingTool: Tool = {
  name: "report_finding",
  description:
    "Report one code-review finding. This is the ONLY way a finding is recorded — a defect described in prose is discarded. Call it once per distinct defect.",
  schema: findingSchema,
  effect: "read-only",
  parallelSafe: true,
  async call(input: unknown, ctx: ToolCtx) {
    const parsed = findingSchema.parse(input);
    ctx.emit?.("finding", parsed);
    return ok(`recorded: ${parsed.file}:${parsed.line} — ${parsed.summary}`, parsed);
  },
};
