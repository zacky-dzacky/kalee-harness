import { afterAll, beforeAll, describe, test } from "bun:test";
import { CASES } from "./conformance.ts";
import { startFakeServer, type FakeServer } from "./fake-server.ts";
import { AnthropicProvider } from "../src/providers/anthropic.ts";
import { OpenAIProvider } from "../src/providers/openai.ts";
import { GoogleProvider } from "../src/providers/google.ts";
import { DEFAULT_CAPS } from "../src/model/provider.ts";
import type { ModelEntry } from "../src/model/registry.ts";

/**
 * The conformance suite against recorded wire formats. Every adapter runs the *same* battery.
 * Adding a fourth wire format means adding three lines here, which is the point.
 */
let server: FakeServer;

beforeAll(() => {
  server = startFakeServer();
  process.env.ANTHROPIC_API_KEY = "test";
  process.env.OPENAI_API_KEY = "test";
  process.env.GEMINI_API_KEY = "test";
});

afterAll(() => server.stop());

const entry = (over: Partial<ModelEntry>): ModelEntry => ({
  id: "test",
  provider: "openai",
  apiModel: "test-model",
  pricing: { input: 1, output: 1 },
  caps: { ...DEFAULT_CAPS, nativeToolCalls: true, parallelToolCalls: true, maxContext: 100_000 },
  ...over,
});

const adapters = [
  {
    name: "anthropic",
    make: () =>
      new AnthropicProvider(entry({ provider: "anthropic", baseURL: `${server.url}/anthropic` })),
  },
  {
    name: "openai",
    make: () => new OpenAIProvider(entry({ provider: "openai", baseURL: `${server.url}/openai/v1` })),
  },
  {
    name: "google",
    make: () => new GoogleProvider(entry({ provider: "google", baseURL: `${server.url}/google` })),
  },
];

for (const adapter of adapters) {
  describe(`conformance: ${adapter.name}`, () => {
    for (const c of CASES) {
      test(c.name, async () => {
        await c.run(adapter.make());
      });
    }
  });
}
