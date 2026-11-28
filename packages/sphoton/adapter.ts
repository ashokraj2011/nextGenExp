import type { SphotonExecutionScope } from "./contracts";

/**
 * Headless descriptor returned by sfield.
 * sfield owns tool registration, closed JSON Schemas, execution, and call logs — never UI.
 */
export type SfieldToolDescriptor = {
  ref: string;
  id: string;
  version: string;
  description?: string;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
};

export type SfieldToolExecutionResult =
  | {
    status: "succeeded";
    toolRef: string;
    output: unknown;
    sfieldRunId?: string;
    sfieldCallId?: string;
  }
  | {
    status: "failed" | "denied";
    toolRef: string;
    sfieldRunId?: string;
    sfieldCallId?: string;
    error: { code: string; message: string };
  };

/**
 * Narrow server adapter injected into sphoton so sphoton can discover schemas
 * and execute reads/actions against the host's sfield instance without coupling
 * sfield to UI concerns or coupling packages/sphoton to apps/server.
 */
export interface SfieldAdapter {
  listTools(): SfieldToolDescriptor[];
  describeTool(toolRef: string): SfieldToolDescriptor | undefined;
  executeRead(input: {
    toolRef: string;
    inputs: Record<string, unknown>;
    scope: SphotonExecutionScope;
    signal?: AbortSignal;
  }): Promise<SfieldToolExecutionResult>;
  executeAction(input: {
    toolRef: string;
    inputs: Record<string, unknown>;
    scope: SphotonExecutionScope;
    signal?: AbortSignal;
  }): Promise<SfieldToolExecutionResult>;
}

export interface SphotonLlmAdapter {
  generateJson(input: {
    systemPrompt: string;
    userPrompt: string;
  }): Promise<unknown | null>;
}
