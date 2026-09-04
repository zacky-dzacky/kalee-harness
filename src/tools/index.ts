import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolDef } from "../model/ir.ts";
import { readFileTool } from "./read_file.ts";
import { grepTool } from "./grep.ts";
import { globTool } from "./glob.ts";
import { gitTools } from "./git.ts";
import { reportFindingTool } from "./report_finding.ts";
import { bashTool } from "./bash.ts";
import type { Tool } from "./types.ts";

export * from "./types.ts";
export { readFileTool, grepTool, globTool, reportFindingTool, bashTool };

/** Every v1 builtin. All read-only except `bash`, which policy gates. */
export const BUILTINS: Tool[] = [
  readFileTool,
  grepTool,
  globTool,
  ...gitTools,
  reportFindingTool,
  bashTool,
];

/**
 * Discovery and routing (LAYERS.md: Tool Interface & Protocol). MCP servers register here
 * later; nothing above this class needs to know where a tool came from.
 */
export class ToolRegistry {
  private byName = new Map<string, Tool>();

  constructor(tools: Tool[] = []) {
    for (const t of tools) this.add(t);
  }

  add(tool: Tool): this {
    if (this.byName.has(tool.name)) throw new Error(`duplicate tool name: ${tool.name}`);
    this.byName.set(tool.name, tool);
    return this;
  }

  get(name: string): Tool | undefined {
    return this.byName.get(name);
  }

  list(): Tool[] {
    return [...this.byName.values()];
  }

  /** Keep only the named tools — how a skill narrows what a pass is allowed to reach for. */
  select(names: string[]): ToolRegistry {
    const missing = names.filter((n) => !this.byName.has(n));
    if (missing.length) throw new Error(`unknown tool(s): ${missing.join(", ")}`);
    return new ToolRegistry(names.map((n) => this.byName.get(n)!));
  }

  /** The provider-facing schema. zod is the source of truth; JSON Schema is derived. */
  defs(): ToolDef[] {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: toJsonSchema(t),
    }));
  }
}

export function toJsonSchema(tool: Tool): Record<string, unknown> {
  const schema = zodToJsonSchema(tool.schema, {
    $refStrategy: "none", // providers vary in $ref support; inline everything
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  delete schema.$schema;
  // Some backends reject a tool schema that is not an object at the top level.
  if (schema.type !== "object") {
    return { type: "object", properties: {}, additionalProperties: false };
  }
  return schema;
}

export function defaultRegistry(): ToolRegistry {
  return new ToolRegistry(BUILTINS);
}

/** The read-only subset — what a review pass gets. */
export function reviewRegistry(): ToolRegistry {
  return new ToolRegistry(BUILTINS.filter((t) => t.effect === "read-only"));
}
