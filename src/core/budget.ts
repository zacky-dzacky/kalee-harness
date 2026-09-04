import type { Usage } from "../model/ir.ts";

/**
 * Adaptation limits (LAYERS.md). Enforced locally because not every backend has a
 * server-side budget knob — and the ones that do disagree about what it counts.
 */
export interface BudgetLimits {
  maxTurns: number;
  maxTokens: number;
  maxWallClockMs: number;
  maxCostUsd: number;
}

export const DEFAULT_LIMITS: BudgetLimits = {
  maxTurns: 30,
  maxTokens: 500_000,
  maxWallClockMs: 10 * 60_000,
  maxCostUsd: 5,
};

export type BudgetStop = { exhausted: true; reason: string } | { exhausted: false };

export class Budget {
  private turns = 0;
  private tokens = 0;
  private cost = 0;
  private started = Date.now();

  constructor(readonly limits: BudgetLimits = DEFAULT_LIMITS) {}

  startTurn(): BudgetStop {
    // Checked before spending, so an exhausted budget never buys one more turn.
    if (this.turns >= this.limits.maxTurns) {
      return { exhausted: true, reason: `turn cap reached (${this.limits.maxTurns})` };
    }
    if (this.tokens >= this.limits.maxTokens) {
      return { exhausted: true, reason: `token cap reached (${this.limits.maxTokens})` };
    }
    if (this.cost >= this.limits.maxCostUsd) {
      return { exhausted: true, reason: `cost cap reached ($${this.limits.maxCostUsd})` };
    }
    const elapsed = Date.now() - this.started;
    if (elapsed >= this.limits.maxWallClockMs) {
      return { exhausted: true, reason: `wall-clock cap reached (${this.limits.maxWallClockMs}ms)` };
    }
    this.turns++;
    return { exhausted: false };
  }

  spend(usage: Usage, costUsd: number): void {
    this.tokens += usage.input + usage.output + usage.cacheRead;
    this.cost += costUsd;
  }

  /** Remaining wall-clock, for handing an AbortSignal to the provider. */
  remainingMs(): number {
    return Math.max(0, this.limits.maxWallClockMs - (Date.now() - this.started));
  }

  snapshot() {
    return { turns: this.turns, tokens: this.tokens, costUsd: this.cost, elapsedMs: Date.now() - this.started };
  }
}
