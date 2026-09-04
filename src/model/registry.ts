import { parse, parseDocument } from "yaml";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { findResource, requireResource } from "../core/roots.ts";
import { DEFAULT_CAPS, type Capabilities, type Pricing } from "./provider.ts";

export type ProviderKind = "anthropic" | "openai" | "google";

export interface ModelEntry {
  id: string;
  provider: ProviderKind;
  apiModel: string;
  baseURL?: string;
  apiKeyEnv?: string;
  pricing: Pricing;
  caps: Capabilities;
}

export type Role = "scan" | "verify" | "default";

export interface Registry {
  path: string;
  models: ModelEntry[];
  roles: Record<string, string>;
}

/**
 * Registry resolution, nearest wins: `./models.yaml`, then `.kalee/models.yaml`, then
 * `~/.kalee/models.yaml`, then the one shipped with the harness.
 */
export function registryPath(cwd = process.cwd()): string {
  const candidates = [join(cwd, "models.yaml"), join(cwd, ".kalee", "models.yaml")];
  return candidates.find((p) => existsSync(p)) ?? requireResource("models.yaml");
}

function coerceCaps(raw: unknown): Capabilities {
  const r = (raw ?? {}) as Partial<Capabilities>;
  return { ...DEFAULT_CAPS, ...r };
}

export async function loadRegistry(cwd = process.cwd()): Promise<Registry> {
  const path = registryPath(cwd);
  const raw = parse(await readFile(path, "utf8")) as {
    models?: unknown[];
    roles?: Record<string, string>;
  };
  const models = (raw.models ?? []).map((m) => {
    const e = m as Record<string, unknown>;
    if (typeof e.id !== "string") throw new Error(`${path}: a model entry is missing \`id\``);
    if (typeof e.provider !== "string") throw new Error(`${path}: model ${e.id} is missing \`provider\``);
    return {
      id: e.id,
      provider: e.provider as ProviderKind,
      apiModel: (e.apiModel as string) ?? e.id,
      baseURL: e.baseURL as string | undefined,
      apiKeyEnv: e.apiKeyEnv as string | undefined,
      pricing: ((e.pricing as Pricing) ?? { input: 0, output: 0 }),
      caps: coerceCaps(e.caps),
    } satisfies ModelEntry;
  });
  return { path, models, roles: raw.roles ?? {} };
}

export function lookup(reg: Registry, id: string): ModelEntry {
  const found = reg.models.find((m) => m.id === id);
  if (found) return found;
  const known = reg.models.map((m) => m.id).join(", ");
  throw new Error(`unknown model \`${id}\`. Known models: ${known}`);
}

/**
 * Resolve a role to a model. Precedence: explicit `--model` override, then a per-role
 * override (`--role-model scan=...`), then `roles:` in the registry, then `roles.default`,
 * then the first entry.
 */
export function resolveRole(
  reg: Registry,
  role: Role,
  overrides: { model?: string; roleModels?: Partial<Record<Role, string>> } = {},
): ModelEntry {
  const id =
    overrides.roleModels?.[role] ??
    overrides.model ??
    reg.roles[role] ??
    reg.roles.default ??
    reg.models[0]?.id;
  if (!id) throw new Error(`${reg.path} defines no models`);
  return lookup(reg, id);
}

/**
 * Write probed capabilities back into `models.yaml`, preserving comments and formatting —
 * this file is hand-maintained, so `kalee doctor` must not reformat it.
 */
export async function writeProbedCaps(
  reg: Registry,
  id: string,
  caps: Partial<Capabilities>,
): Promise<void> {
  const doc = parseDocument(await readFile(reg.path, "utf8"));
  const models = doc.get("models") as { items?: unknown[] } | undefined;
  const items = models?.items ?? [];
  const idx = items.findIndex(
    (it) => (it as { get(k: string): unknown }).get("id") === id,
  );
  if (idx === -1) throw new Error(`${reg.path} has no model \`${id}\` to update`);
  for (const [k, v] of Object.entries(caps)) {
    doc.setIn(["models", idx, "caps", k], v);
  }
  await writeFile(reg.path, String(doc), "utf8");
}
