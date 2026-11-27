/** @sfield/core public surface. */
export * from "./types/common.js";
export * from "./types/tool.js";
export * from "./types/memory.js";
export * from "./types/retrieval.js";
export * from "./types/context.js";
export * from "./types/model.js";
export * from "./types/runtime.js";
export * from "./types/persistence.js";
export * from "./types/options.js";
export * from "./types/preset.js";
export * from "./errors.js";
export * from "./config/types.js";
export { loadConfigFile, loadConfigDocument, parseDocumentText, substituteEnv } from "./config/load.js";
export { compileConfig, shorthandIdentity, PROVIDER_PARAMS, type CompileContext, type CompileRegistrations } from "./config/compile.js";
export { explainConfig, formatExplanation } from "./config/explain.js";
export { applyOverrides } from "./config/overrides.js";
export { AGENT_DEFAULTS, TOOL_POLICY_DEFAULTS, HOST_DEFAULTS, CONTEXT_SOURCE_DEFAULTS } from "./config/defaults.js";
export { ROOT_CONFIG_SCHEMA } from "./config/root-schema.js";
export { canonicalize, canonicalValue } from "./util/jcs.js";
export { digestJson, digestBytes, sha256Hex, newId, nowIso, isoAfter } from "./util/digest.js";
export { parseSSE, type SSEMessage } from "./util/sse.js";
export { estimateTokens, estimateJsonTokens, TOKEN_ESTIMATOR_ID } from "./util/tokens.js";
export { Scrubber, StreamScanner } from "./util/scrub.js";
export { resolveBinding, parseRefPath, checkBinding, OMIT } from "./util/refs.js";
export { globToRegExp, matchesAny } from "./util/glob.js";
export { withTimeout, linkSignals, sleep, Semaphore, Mutex, BoundedQueue, Deferred, TimeoutError } from "./util/async.js";
export { SchemaValidator, sharedValidator, SCHEMA_COMPILER_VERSION } from "./schema/validator.js";
export { checkSchemaSubset } from "./schema/subset.js";
export { applySelect } from "./schema/select.js";
export { FORMATS, FORMATS_VERSION } from "./schema/formats.js";
export { defineTool, normalizeTool, toolDigestInput, BUILTIN_TOOL_IDS, TOOL_ID_RE, SEMVER_RE } from "./registry/define-tool.js";
export { ToolRegistry, type ToolDescription } from "./registry/registry.js";
export { FunctionAdapter } from "./registry/function-adapter.js";
export { ToolError } from "./registry/tool-error.js";
export { BUILTIN_TOOLS, ASK_USER, MEMORY_REMEMBER, MEMORY_FORGET } from "./registry/builtins.js";
export { computeEffectiveTools, aliasFor } from "./registry/effective.js";
export { effectAllowed, approvalRequired, type PolicyPreset } from "./policy/presets.js";
export { LoopDetector, callIdentity, emptyLoopState } from "./policy/loop-detector.js";
export { ApprovalService } from "./policy/approvals.js";
export {
  TokenBucketRateLimiter,
  CircuitBreaker,
  ToolResilienceGuard,
  createToolResilienceGuard,
  type RateLimitConfig,
  type CircuitBreakerConfig,
  type CircuitState,
  type ResilienceStatus,
} from "./policy/resilience.js";
export {
  createPrincipal,
  createAgentPrincipal,
  principalKindOf,
  isAgentPrincipal,
  effectiveSubjectId,
  resolveIdentifier,
  principalToBindingRoot,
  type CreatePrincipalInput,
  type CreateAgentPrincipalInput,
} from "./security/identity.js";
export {
  PiiFirewall,
  createPiiFirewall,
  createPiiFirewallHook,
  type PiiCategory,
  type PiiCustomRule,
  type PiiFirewallOptions,
  type PiiRedactionToken,
  type PiiScrubResult,
} from "./security/pii-firewall.js";
export { ToolPipeline, type PipelineDeps, type PreparedCall, type DispatchRequest } from "./pipeline/execute.js";
export { shortenForModel } from "./pipeline/views.js";
export { InMemoryArtifactStore } from "./persistence/artifacts-memory.js";
export { FilesystemArtifactStore, type FilesystemArtifactStoreOptions } from "./persistence/artifacts-fs.js";
export { EphemeralPersistence } from "./persistence/ephemeral.js";
export { InMemoryMemoryRepository } from "./memory/repository-memory.js";
export { InMemoryMemoryIndex } from "./memory/index-memory.js";
export {
  VectorMemoryIndex,
  HashEmbeddingProvider,
  cosineSimilarity,
  type EmbeddingProvider,
  type VectorMemoryIndexOptions,
} from "./memory/vector-index.js";
export { MemoryService, looksLikeSecret } from "./memory/service.js";
export { RetrievalService, type RetrievalOutcome } from "./retrieval/service.js";
export { buildContext, validatePairing, type ContextBuildInput, type ContextBuildOutput } from "./context/builder.js";
export {
  ConversationCompactor,
  ROLLING_SUMMARY_KEY,
  buildExtractiveSummary,
  formatRollingSummary,
  type CompactThreadInput,
  type CompactThreadResult,
  type CompactorTurnInput,
  type RollingThreadSummary,
} from "./context/compactor.js";
export { ModelGateway, type DispatchResult } from "./gateway/gateway.js";
export { AnthropicProvider, ANTHROPIC_API_VERSION, ANTHROPIC_DEFAULT_BASE_URL } from "./gateway/providers/anthropic.js";
export { GeminiProvider, GEMINI_DEFAULT_BASE_URL } from "./gateway/providers/gemini.js";
export { OpenAICompatibleProvider } from "./gateway/providers/openai-compatible.js";
export { toolOverheadTokens, stableBody, schemaIsStrictCompatible } from "./gateway/providers/shared.js";
export { costMicroUsd, estimateMaxCost } from "./gateway/pricing.js";
export { AgentRuntime, inputRequirement, messageToNeutral } from "./runtime/runtime.js";
export { Scheduler } from "./runtime/scheduler.js";
export { EventBus } from "./runtime/events.js";
export { RunHandleImpl, toResult } from "./runtime/run-handle.js";
export { RunService } from "./runtime/run-service.js";
export { ChatHarness, type ChatScope, type ChatThread, type ChatMessageInput } from "./chat/harness.js";
export {
  AgenticHarness,
  runAgenticHarness,
  type AgenticHarnessDeps,
  type AgenticHarnessResult,
  type AgenticHarnessSpec,
  type HarnessClarificationChoice,
  type HarnessContext,
  type HarnessGatherOutcome,
  type HarnessPlanOutcome,
  type HarnessStageName,
  type HarnessStageRecord,
  type HarnessStageStatus,
  type HarnessSynthesizeOutcome,
  type HarnessTrace,
  type HarnessVerifyOutcome,
} from "./runtime/agentic-harness.js";
export { ExternalExecutionScope, type ExecutionScope, type ExecutionScopeOptions } from "./runtime/execution-scope.js";
export {
  SFieldMcpServer,
  createSFieldMcpServer,
  MCP_PROTOCOL_VERSION,
  type McpCallContext,
  type McpCallResult,
  type McpExtraTool,
  type McpHttpResponse,
  type McpResourceContent,
  type McpResourceDefinition,
  type McpToolAnnotations,
  type McpToolDescriptor,
  type SFieldMcpHost,
  type SFieldMcpServerOptions,
} from "./mcp/server.js";
export {
  McpClient,
  createMcpClient,
  createMcpProxyTools,
  type McpClientOptions,
  type McpProxyToolOptions,
} from "./mcp/client.js";
export {
  DelegationService,
  type DelegateInput,
  type DelegationOutcome,
  type DelegatedChildRecord,
} from "./runtime/delegation.js";
export {
  streamRun,
  normalizeRunEvent,
  formatRunStreamSse,
  type RunStreamChunk,
} from "./runtime/stream.js";
export { PluginManager, CORE_API_VERSION, CORE_VERSION } from "./plugins/manager.js";
export { EnvSecretResolver, CompositeSecretResolver } from "./secrets.js";
export { checkLockApproved, approveLock, effectiveRequireApproved } from "./governance/lock.js";
export { createDevAuthorizer, LOCAL_DEV_PRINCIPAL } from "./dev-authorizer.js";
export { SField, shorthandModelBinding, shorthandConnection, PROVIDER_DEFAULT_LIMITS, type ValidateOptions, type ValidationReport, type SFieldCreateOptions } from "./sfield.js";
