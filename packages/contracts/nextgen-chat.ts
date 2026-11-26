import { z } from "zod";

/* ============================================================================
 * #2 Parallel Futures Simulator + 1-Click Governed Commit
 * ========================================================================== */

export const scenarioPlanInputSchema = z.object({
  scenarioName: z.string().trim().min(1).max(80),
  personaId: z.string().trim().min(1).max(80),
  monthlyDepositUsd: z.number().min(0).max(50_000),
  horizonMonths: z.number().int().min(6).max(360),
  expectedReturnPct: z.number().min(0).max(20),
  equityAllocationPct: z.number().int().min(0).max(100),
  targetGoalUsd: z.number().min(1_000).max(10_000_000),
  projectedEndingUsd: z.number().min(0),
}).strict();
export type ScenarioPlanInput = z.infer<typeof scenarioPlanInputSchema>;

/* ============================================================================
 * #3 Living Threads — Autonomous Watchcards
 * ========================================================================== */

export const watchcardMetricSchema = z.enum(["cash_balance", "equity_value", "goal_progress", "portfolio_total"]);
export type WatchcardMetric = z.infer<typeof watchcardMetricSchema>;

export const watchcardSchema = z.object({
  id: z.string(),
  conversationId: z.string().default("default"),
  personaId: z.string(),
  title: z.string().trim().min(2).max(140),
  metric: watchcardMetricSchema,
  operator: z.enum(["gte", "lte"]),
  thresholdUsd: z.number().min(0).max(100_000_000),
  actionSummary: z.string().trim().min(2).max(240),
  actionPrompt: z.string().trim().min(2).max(400),
  status: z.enum(["watching", "triggered", "executed", "dismissed"]),
  currentValueUsd: z.number(),
  approvalId: z.string().optional(),
  auditId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  triggeredAt: z.string().optional(),
  executedAt: z.string().optional(),
}).strict();
export type Watchcard = z.infer<typeof watchcardSchema>;

export const createWatchcardInputSchema = z.object({
  conversationId: z.string().trim().min(1).max(80).default("default"),
  personaId: z.string().trim().min(1).max(80).default("demo-learner"),
  title: z.string().trim().min(2).max(140),
  metric: watchcardMetricSchema.default("cash_balance"),
  operator: z.enum(["gte", "lte"]).default("gte"),
  thresholdUsd: z.number().min(0).max(100_000_000),
  actionSummary: z.string().trim().min(2).max(240),
  actionPrompt: z.string().trim().min(2).max(400).optional(),
}).strict();
export type CreateWatchcardInput = z.input<typeof createWatchcardInputSchema>;

/* ============================================================================
 * #4 Instant Expertise Morph Dial
 * ========================================================================== */

export const expertiseModeSchema = z.enum(["guided", "standard", "pro"]);
export type ExpertiseMode = z.infer<typeof expertiseModeSchema>;

/* ============================================================================
 * #6 Consumer A2A — "My Personal AI <-> Enterprise AI" Delegated Negotiation
 * ========================================================================== */

export const delegationScopeSchema = z.enum([
  "read_balances",
  "search_policies",
  "stage_drafts",
  "request_actions",
]);
export type DelegationScope = z.infer<typeof delegationScopeSchema>;

export const agentDelegationPassSchema = z.object({
  passId: z.string(),
  token: z.string(),
  personaId: z.string(),
  agentName: z.string().trim().min(2).max(80),
  allowedScopes: z.array(delegationScopeSchema).min(1).max(4),
  maxTransactionUsd: z.number().min(0).max(1_000_000),
  status: z.enum(["active", "revoked"]),
  createdAt: z.string(),
  expiresAt: z.string(),
}).strict();
export type AgentDelegationPass = z.infer<typeof agentDelegationPassSchema>;

export const createDelegationPassInputSchema = z.object({
  personaId: z.string().trim().min(1).max(80).default("demo-learner"),
  agentName: z.string().trim().min(2).max(80).default("Personal Claude / Copilot"),
  allowedScopes: z.array(delegationScopeSchema).min(1).max(4).default(["read_balances", "search_policies", "stage_drafts", "request_actions"]),
  maxTransactionUsd: z.number().min(0).max(1_000_000).default(5_000),
  expiresInHours: z.number().int().min(1).max(168).default(24),
}).strict();
export type CreateDelegationPassInput = z.input<typeof createDelegationPassInputSchema>;

export const negotiationMessageSchema = z.object({
  id: z.string(),
  speaker: z.enum(["personal_ai", "cep_agent", "sfield_guard"]),
  protocol: z.enum(["A2A", "MCP", "sfield-HITL"]),
  text: z.string(),
  payloadSummary: z.string().optional(),
  timestamp: z.string(),
}).strict();
export type NegotiationMessage = z.infer<typeof negotiationMessageSchema>;

export const negotiationSessionSchema = z.object({
  sessionId: z.string(),
  passId: z.string(),
  personaId: z.string(),
  agentName: z.string(),
  goal: z.string(),
  requestedAmountUsd: z.number().min(0),
  status: z.enum(["completed", "paused_for_approval", "denied"]),
  approvalId: z.string().optional(),
  auditId: z.string().optional(),
  transcript: z.array(negotiationMessageSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();
export type NegotiationSession = z.infer<typeof negotiationSessionSchema>;

export const runNegotiationInputSchema = z.object({
  passId: z.string().trim().min(3).max(80),
  goal: z.string().trim().min(4).max(300),
  requestedAmountUsd: z.number().min(0).max(1_000_000).default(8_500),
}).strict();
export type RunNegotiationInput = z.input<typeof runNegotiationInputSchema>;

export interface AgentDelegationView {
  passes: AgentDelegationPass[];
  negotiations: NegotiationSession[];
}
