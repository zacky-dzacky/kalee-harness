/**
 * A local server that speaks all three wire formats, so the conformance suite runs offline in
 * CI against the *real* adapter code rather than a mock of it. Mocking `ModelProvider` would
 * test nothing: the translation is the part that breaks.
 *
 * Every format deliberately splits the tool-call JSON across two SSE frames, because "survives
 * a frame split mid-JSON" is a real failure mode and the only way to catch it is to cause it.
 */
export interface FakeServer {
  url: string;
  stop(): void;
  requests: unknown[];
}

interface Parsed {
  wantsTool: boolean;
  hasToolResult: boolean;
  badTool: boolean;
}

export function startFakeServer(): FakeServer {
  const requests: unknown[] = [];

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "POST" ? ((await req.json()) as Record<string, unknown>) : {};
      requests.push({ path: url.pathname, body });

      if (url.pathname.endsWith("/count_tokens")) {
        return json({ input_tokens: 42 });
      }
      if (url.pathname.includes(":countTokens")) {
        return json({ totalTokens: 42 });
      }

      const kind = url.pathname.includes("/anthropic/")
        ? "anthropic"
        : url.pathname.includes("/google/") || url.pathname.includes(":streamGenerateContent")
          ? "google"
          : "openai";

      const p = parse(kind, body);
      if (p.badTool) {
        return json({ error: { message: "tool name must not be empty", type: "invalid_request_error" } }, 400);
      }

      const frames =
        kind === "anthropic"
          ? anthropicFrames(p)
          : kind === "google"
            ? googleFrames(p)
            : openaiFrames(p);
      return sse(frames);
    },
  });

  return {
    url: `http://localhost:${server.port}`,
    stop: () => server.stop(true),
    requests,
  };
}

function parse(kind: string, body: Record<string, unknown>): Parsed {
  const raw = JSON.stringify(body);
  const tools = (body.tools ?? []) as unknown[];
  let badTool = false;
  if (kind === "google") {
    const decls = (tools[0] as { functionDeclarations?: { name?: string }[] })?.functionDeclarations ?? [];
    badTool = decls.some((d) => !d.name);
  } else if (kind === "anthropic") {
    badTool = (tools as { name?: string }[]).some((t) => !t.name);
  } else {
    badTool = (tools as { function?: { name?: string } }[]).some((t) => !t.function?.name);
  }
  return {
    wantsTool: tools.length > 0,
    // The second half of the round-trip: a result has already been sent back.
    hasToolResult: /tool_result|"role":"tool"|functionResponse/.test(raw),
    badTool,
  };
}

// --- Anthropic ---------------------------------------------------------------

function anthropicFrames(p: Parsed): string[] {
  const out: string[] = [
    ev("message_start", {
      type: "message_start",
      message: { usage: { input_tokens: 25, output_tokens: 0, cache_read_input_tokens: 0 } },
    }),
  ];

  if (p.wantsTool && !p.hasToolResult) {
    out.push(
      ev("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_fake1", name: "get_weather", input: {} },
      }),
      // Split mid-JSON, on purpose.
      ev("content_block_delta", {
        type: "content_block_delta", index: 0,
        delta: { type: "input_json_delta", partial_json: '{"ci' },
      }),
      ev("content_block_delta", {
        type: "content_block_delta", index: 0,
        delta: { type: "input_json_delta", partial_json: 'ty":"Paris"}' },
      }),
      ev("content_block_stop", { type: "content_block_stop", index: 0 }),
      ev("message_delta", {
        type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 12 },
      }),
    );
  } else {
    const text = p.hasToolResult ? "It is 18C and raining in Paris." : "ready";
    out.push(
      ev("content_block_start", {
        type: "content_block_start", index: 0, content_block: { type: "text", text: "" },
      }),
      ...chunks(text).map((c) =>
        ev("content_block_delta", {
          type: "content_block_delta", index: 0, delta: { type: "text_delta", text: c },
        }),
      ),
      ev("content_block_stop", { type: "content_block_stop", index: 0 }),
      ev("message_delta", {
        type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 8 },
      }),
    );
  }

  out.push(ev("message_stop", { type: "message_stop" }));
  return out;
}

// --- OpenAI ------------------------------------------------------------------

function openaiFrames(p: Parsed): string[] {
  const out: string[] = [];
  if (p.wantsTool && !p.hasToolResult) {
    out.push(
      data({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: "call_fake1", type: "function", function: { name: "get_weather", arguments: '{"ci' } },
              ],
            },
          },
        ],
      }),
      data({
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"Paris"}' } }] } },
        ],
      }),
      data({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
    );
  } else {
    const text = p.hasToolResult ? "It is 18C and raining in Paris." : "ready";
    for (const c of chunks(text)) out.push(data({ choices: [{ index: 0, delta: { content: c } }] }));
    out.push(data({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
  }
  out.push(
    data({
      choices: [],
      usage: { prompt_tokens: 25, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 0 } },
    }),
    "data: [DONE]\n\n",
  );
  return out;
}

// --- Google ------------------------------------------------------------------

function googleFrames(p: Parsed): string[] {
  const usage = { promptTokenCount: 25, candidatesTokenCount: 8 };
  if (p.wantsTool && !p.hasToolResult) {
    return [
      data({
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ functionCall: { id: "call_fake1", name: "get_weather", args: { city: "Paris" } } }],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: usage,
      }),
    ];
  }
  const text = p.hasToolResult ? "It is 18C and raining in Paris." : "ready";
  const parts = chunks(text);
  return parts.map((c, i) =>
    data({
      candidates: [
        {
          content: { role: "model", parts: [{ text: c }] },
          ...(i === parts.length - 1 ? { finishReason: "STOP" } : {}),
        },
      ],
      usageMetadata: usage,
    }),
  );
}

// --- helpers -----------------------------------------------------------------

function chunks(s: string): string[] {
  const mid = Math.ceil(s.length / 2);
  return [s.slice(0, mid), s.slice(mid)];
}

const ev = (type: string, payload: unknown) => `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
const data = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;

function sse(frames: string[]): Response {
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}
