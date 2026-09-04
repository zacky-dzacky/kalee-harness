import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import type { PermissionMode } from "./policy.ts";
import type { BudgetLimits } from "./budget.ts";
import { DEFAULT_LIMITS } from "./budget.ts";
import type { Effort } from "../model/ir.ts";

/** `~/.kalee/config.yaml` merged with `.kalee/config.yaml`, project wins. */
export interface Config {
  model?: string;
  roleModels?: { scan?: string; verify?: string };
  effort?: Effort;
  format?: "terminal" | "json" | "markdown";
  permissionMode?: PermissionMode;
  allow?: string[];
  deny?: string[];
  limits?: Partial<BudgetLimits>;
}

export async function loadConfig(cwd: string): Promise<Config> {
  const files = [join(homedir(), ".kalee", "config.yaml"), join(cwd, ".kalee", "config.yaml")];
  let merged: Config = {};
  for (const f of files) {
    if (!existsSync(f)) continue;
    const c = (parse(await readFile(f, "utf8")) ?? {}) as Config;
    merged = {
      ...merged,
      ...c,
      roleModels: { ...merged.roleModels, ...c.roleModels },
      limits: { ...merged.limits, ...c.limits },
      allow: [...(merged.allow ?? []), ...(c.allow ?? [])],
      deny: [...(merged.deny ?? []), ...(c.deny ?? [])],
    };
  }
  return merged;
}

export function limitsFrom(config: Config, overrides: Partial<BudgetLimits> = {}): BudgetLimits {
  return { ...DEFAULT_LIMITS, ...config.limits, ...overrides };
}
