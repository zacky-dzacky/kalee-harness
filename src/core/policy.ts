import type { Effect } from "../tools/types.ts";

/**
 * Permission control and policy enforcement (LAYERS.md: Governance & Security).
 *
 * The decision is made here and *only* here; the loop asks and obeys. Every decision emits an
 * audit record, so "what was this agent allowed to do" is answerable after the fact.
 */
export type PermissionMode = "readonly" | "ask" | "auto" | "deny";

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
}

export interface AuditRecord {
  at: string;
  tool: string;
  effect: Effect;
  allowed: boolean;
  reason: string;
  mode: PermissionMode;
}

export interface PolicyOptions {
  mode: PermissionMode;
  /** Tool-name globs that are always allowed, whatever the mode. */
  allow?: string[];
  /** Tool-name globs that are always denied. Deny beats allow. */
  deny?: string[];
  /** Prompt for `ask` mode. Absent in a non-interactive run, which then denies. */
  confirm?(tool: string, effect: Effect, input: unknown): Promise<boolean>;
}

export class Policy {
  readonly mode: PermissionMode;
  private allow: RegExp[];
  private denyList: RegExp[];
  private confirm?: PolicyOptions["confirm"];
  private audit: AuditRecord[] = [];

  constructor(opts: PolicyOptions) {
    this.mode = opts.mode;
    this.allow = (opts.allow ?? []).map(globToRe);
    this.denyList = (opts.deny ?? []).map(globToRe);
    this.confirm = opts.confirm;
  }

  async check(tool: string, effect: Effect, input: unknown): Promise<PolicyDecision> {
    const d = await this.decide(tool, effect, input);
    this.audit.push({
      at: new Date().toISOString(),
      tool,
      effect,
      allowed: d.allowed,
      reason: d.reason,
      mode: this.mode,
    });
    return d;
  }

  private async decide(tool: string, effect: Effect, input: unknown): Promise<PolicyDecision> {
    // Deny beats every allowance, including an explicit allow glob.
    if (this.denyList.some((r) => r.test(tool))) {
      return { allowed: false, reason: "matched a deny rule" };
    }
    if (this.allow.some((r) => r.test(tool))) {
      return { allowed: true, reason: "matched an allow rule" };
    }
    switch (this.mode) {
      case "deny":
        return { allowed: false, reason: "permission mode is deny" };
      case "auto":
        return { allowed: true, reason: "permission mode is auto" };
      case "readonly":
        return effect === "read-only"
          ? { allowed: true, reason: "read-only tool" }
          : { allowed: false, reason: `${effect} tool blocked in readonly mode` };
      case "ask": {
        if (effect === "read-only") return { allowed: true, reason: "read-only tool" };
        if (!this.confirm) {
          return { allowed: false, reason: "ask mode with no way to prompt (non-interactive)" };
        }
        const yes = await this.confirm(tool, effect, input);
        return { allowed: yes, reason: yes ? "approved by the user" : "declined by the user" };
      }
      default:
        return { allowed: false, reason: "unknown permission mode" };
    }
  }

  records(): readonly AuditRecord[] {
    return this.audit;
  }
}

function globToRe(glob: string): RegExp {
  const body = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${body}$`);
}

/** v1 default: review needs nothing but read-only tools, so nothing else is permitted. */
export const readonlyPolicy = () => new Policy({ mode: "readonly" });
