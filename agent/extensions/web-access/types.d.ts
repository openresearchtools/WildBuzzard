declare module "@earendil-works/pi-coding-agent" {
  type Api = import("@earendil-works/pi-ai").Api;
  type Model = import("@earendil-works/pi-ai").Model<Api>;
  type TSchema = import("typebox").TSchema;
  type Static<T extends TSchema> = import("typebox").Static<T>;
  export interface ToolContent {
    type: "text" | "image";
    text?: string;
    data?: string;
    mimeType?: string;
  }

  export interface ToolExecutionContext {
    cwd: string;
    model: Model | undefined;
    scopedModels: readonly { model: Model }[];
    modelRegistry: {
      find(provider: string, modelId: string): Model | undefined;
      getApiKeyAndHeaders(model: Model): Promise<
        | { ok: true; apiKey?: string; headers?: Record<string, string> }
        | { ok: false; error: string }
      >;
    };
    sessionManager: {
      getSessionId(): string;
      getBranch(): Array<{
        type: string;
        customType?: string;
        data?: unknown;
      }>;
    };
  }

  export interface ToolDefinition<T extends TSchema = TSchema> {
    name: string;
    label: string;
    description: string;
    parameters: T;
    executionMode?: "parallel" | "sequential";
    execute(
      toolCallId: string,
      params: Static<T>,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      context: ToolExecutionContext
    ): Promise<{ content: ToolContent[]; details?: unknown }>;
  }

  export interface ExtensionAPI {
    registerTool<T extends TSchema>(definition: ToolDefinition<T>): void;
    appendEntry(customType: string, data: unknown): void;
    getActiveTools(): string[];
    setActiveTools(names: string[]): void;
    on(
      event: "resources_discover",
      handler: () => Promise<{ skillPaths?: string[] }>
    ): void;
    on(
      event: "session_start",
      handler: (event: unknown, context: ToolExecutionContext) => void
    ): void;
    on(
      event: "before_agent_start",
      handler: (event: { prompt: string }, context: ToolExecutionContext) => void
    ): void;
  }

  export function defineTool<T extends TSchema>(
    definition: ToolDefinition<T>
  ): ToolDefinition<T>;
}
