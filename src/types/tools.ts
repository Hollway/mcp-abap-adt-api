/**
 * Minimal JSON Schema subset used by the tool definitions, plus the MCP tool
 * annotations a client can use to decide how much friction a call deserves.
 */
export interface JsonSchemaProperty {
  type?: string | string[];
  description?: string;
  enum?: (string | number | boolean)[];
  default?: unknown;
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean | JsonSchemaProperty;
  /**
   * Not a JSON Schema keyword - kept because existing definitions carry it.
   * What actually makes a property optional is its absence from `required`.
   */
  optional?: boolean;
}

export interface ToolAnnotations {
  title?: string;
  /** The tool does not change the target system. */
  readOnlyHint?: boolean;
  /** The tool can destroy work that cannot be restored from the system. */
  destructiveHint?: boolean;
  /** Calling it twice with the same arguments has the same effect as once. */
  idempotentHint?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, JsonSchemaProperty>;
    required?: string[];
  };
  annotations?: ToolAnnotations;
}
