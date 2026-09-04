import { ProviderError } from "../model/ir.ts";
import type { ModelProvider } from "../model/provider.ts";
import type { ModelEntry, Registry, Role } from "../model/registry.ts";
import { resolveRole } from "../model/registry.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { GoogleProvider } from "./google.ts";
import { OpenAIProvider } from "./openai.ts";
import { ShimProvider } from "./shim.ts";

/**
 * The one place that maps a registry entry to a live adapter. Nothing above this file names
 * a provider; everything below is wire-format specific.
 */
export function makeProvider(entry: ModelEntry): ModelProvider {
  let p: ModelProvider;
  switch (entry.provider) {
    case "anthropic":
      p = new AnthropicProvider(entry);
      break;
    case "openai":
      p = new OpenAIProvider(entry);
      break;
    case "google":
      p = new GoogleProvider(entry);
      break;
    default:
      throw new ProviderError(
        `unknown provider \`${entry.provider}\` for model ${entry.id}`,
        "unsupported",
        String(entry.provider),
        false,
      );
  }
  // Capability-driven degradation, decided once, here.
  return p.caps.nativeToolCalls ? p : new ShimProvider(p);
}

export function providerForRole(
  reg: Registry,
  role: Role,
  overrides: { model?: string; roleModels?: Partial<Record<Role, string>> } = {},
): ModelProvider {
  return makeProvider(resolveRole(reg, role, overrides));
}
