import type { TSchema, Static } from "typebox";

declare module "@earendil-works/pi-coding-agent" {
  export interface BrowserToolContent {
    type: "text" | "image";
    text?: string;
    data?: string;
    mimeType?: string;
  }

  export interface BrowserToolExecutionContext {
    cwd: string;
    sessionManager: {
      getSessionId(): string;
    };
  }

  export interface BrowserToolDefinition<T extends TSchema = TSchema> {
    name: string;
    label: string;
    description: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    parameters: T;
    executionMode?: "parallel" | "sequential";
    execute(
      toolCallId: string,
      params: Static<T>,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      context: BrowserToolExecutionContext
    ): Promise<{ content: BrowserToolContent[]; details?: unknown }>;
  }

  export interface ExtensionAPI {
    registerTool<T extends TSchema>(definition: BrowserToolDefinition<T>): void;
    on(
      event: "resources_discover",
      handler: (
        event: { cwd: string; reason: "startup" | "reload" },
        context: unknown
      ) => Promise<{
        skillPaths?: string[];
        promptPaths?: string[];
        themePaths?: string[];
      }>
    ): void;
  }

  export function defineTool<T extends TSchema>(
    definition: BrowserToolDefinition<T>
  ): BrowserToolDefinition<T>;
}
