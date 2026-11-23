import { z } from "zod";

export const experienceAgentId = "experience-agent";
export const axeBudget = Object.freeze({
  modelCalls: 12, toolCalls: 16, planRevisions: 4, contexts: 4, parallelReads: 3, activeSeconds: 60, clarifications: 2,
});
export type ExecutionBudget = { -readonly [Key in keyof typeof axeBudget]: number };
export const capabilityIdSchema = z.string().regex(/^[a-z][a-z0-9]*(?:[.\-][a-z0-9]+)+$/).max(84);
export const versionSchema = z.string().regex(/^\d+\.\d+\.\d+$/).max(25);
const key = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/);
const text = z.string().trim().min(1).max(360);
export const components = ["GoalProgress", "Portfolio", "Balances", "Chart", "Metric", "Content", "FundingOptions", "FundingPreview", "Form", "Summary"] as const;
export const outputKinds = ["progress", "portfolio", "balances", "projection", "contribution", "content", "fundingStatus", "fundingOptions", "fundingPreview", "address"] as const;
const fieldShared = { id: key, label: text, required: z.boolean() };
export const inputFieldSchema = z.discriminatedUnion("type", [
  z.object({ ...fieldShared, type: z.literal("integer"), min: z.number().int().nonnegative(), max: z.number().int().positive(),
    unit: z.enum(["cents", "months"]).optional(), presentation: z.enum(["amount", "number", "slider"]).optional(),
    default: z.number().int().nonnegative().optional() }).strict(),
  z.object({ ...fieldShared, type: z.literal("choice"), optionsFrom: z.literal("fundingOptions") }).strict(),
  z.object({ ...fieldShared, type: z.literal("text"), maxLength: z.number().int().min(1).max(120) }).strict(),
]);
export type InputField = z.infer<typeof inputFieldSchema>;
export const manifestSchema = z.object({
  schemaVersion: z.literal("1.0"), id: capabilityIdSchema, version: versionSchema, title: text, description: text,
  supportedGoals: z.array(text).min(1).max(12), discovery: z.object({
    contexts: z.array(key).min(1).max(axeBudget.contexts),
    keywords: z.array(text).min(1).max(24),
    explicitPhrases: z.array(text).max(12).optional(),
    planningCompanions: z.array(z.string().regex(/^[a-z][a-z0-9.\-]+@\d+\.\d+\.\d+$/)).max(3).optional(),
  }).strict(),
  eligibility: z.object({ authority: z.literal("treatment-selector"), kind: z.enum(["capability", "workflow"]), id: capabilityIdSchema, version: versionSchema }).strict(),
  inputs: z.array(inputFieldSchema).max(8),
  tools: z.array(z.string().regex(/^[a-z][a-z0-9.\-]+@\d+\.\d+\.\d+$/)).min(1).max(6),
  invariants: z.array(key).min(1).max(12),
  execution: z.object({
    mode: z.enum(["direct", "ordered", "agent"]), resumable: z.boolean(), route: z.enum(["simple", "goal"]),
  }).strict(),
  policy: z.object({ effect: z.literal("read"), requiresApproval: z.literal(false) }).strict(),
  experience: z.object({ allowedComponents: z.array(z.enum(components)).min(1).max(components.length) }).strict(),
  completionCriteria: z.array(z.enum(outputKinds)).min(1).max(4),
}).strict();
export type CapabilityManifest = z.infer<typeof manifestSchema>;
export type OutputKind = typeof outputKinds[number];
export type ComponentKind = typeof components[number];
export const componentOutputs: Record<ComponentKind, readonly OutputKind[]> = {
  GoalProgress: ["progress"], Portfolio: ["portfolio"], Balances: ["balances"],
  Metric: ["portfolio", "contribution"], Chart: ["projection"], Content: ["content"],
  FundingOptions: ["fundingOptions"], FundingPreview: ["fundingPreview"], Form: [], Summary: ["address"],
};
export type CapabilityRef = Pick<CapabilityManifest, "id" | "version">;
export const capabilityRef = ({ id, version }: CapabilityRef) => id + "@" + version;
export const inputValuesSchema = z.record(key, z.union([z.number().int().nonnegative().max(1_000_000_000), z.string().trim().min(1).max(120)]))
  .refine((values) => Object.keys(values).length <= 8);
export type InputValues = z.infer<typeof inputValuesSchema>;

export const stepSchema = z.object({
  id: key, capabilityId: capabilityIdSchema, version: versionSchema, dependsOn: z.array(key).max(6), required: z.boolean(),
}).strict();
export const goalTypes = ["information", "retrieval", "analysis", "simulation", "action", "planning", "continuation", "correction", "cancellation", "conversation"] as const;
export const planProposalSchema = z.object({
  objective: text, intentType: z.enum(goalTypes), steps: z.array(stepSchema).min(1).max(6),
}).strict();
export type PlanProposal = z.infer<typeof planProposalSchema>;
export type PlanStep = PlanProposal["steps"][number];
export type ExecutionPlan = PlanProposal & { planId: string; goalId: string; revision: number };

export const experienceProposalSchema = z.object({
  disposition: z.enum(["show", "clarify", "pass"]), layout: z.enum(["stack", "dashboard"]),
  sections: z.array(z.object({ stepId: key, component: z.enum(components) }).strict()).max(16),
}).strict();
export type ExperienceProposal = z.infer<typeof experienceProposalSchema>;
export type ExperienceIR = {
  goalId: string; revision: number; layout: ExperienceProposal["layout"];
  sections: { stepId: string; component: ComponentKind; evidenceId?: string }[];
};

export type EligibilityGrant = {
  grantId: string; customerRef: string; runId: string; turnId: string; contextId: string; decisionId: string;
  allowedUses: { capabilityId: string; version: string; tools: string[]; operation: "preview" }[];
  issuedAt: number; expiresAt: number;
};

export type Evidence = {
  evidenceId: string; runId: string; executionId: string; customerRef: string; journeyId: string;
  stepId: string; source: string; callId: string; grantId: string; outputKind: OutputKind;
  status: "verified"; payload: unknown; observedAt: number; expiresAt: number;
};
export type StepResult = {
  stepId: string; capability: string; status: "completed" | "waiting_input" | "blocked" | "failed";
  evidenceIds: string[]; missing?: string[]; reason?: string;
};
export type JourneyStatus = "created" | "planning" | "executing" | "waiting_input" | "paused" | "partially_completed" | "completed" | "cancelled" | "failed";
export type Journey = {
  id: string; goalId: string; threadId: string; objective: string; status: JourneyStatus;
  createdAt: number; updatedAt: number; runId: string; turnId: string; revision: number; clarifications: number;
  plan: ExecutionPlan; inputs: InputValues; results: StepResult[]; excludePromotions: boolean;
  pending?: { requestId: string; expiresAt: number };
  confirmations?: { objective: "first_deposit"; eventId: string; confirmedAt: number }[];
};
export type DecisionEvent = {
  sequence: number; type: string; at: number; runId: string; turnId: string; journeyId?: string;
  detail?: unknown;
};
export type AgentAction = {
  operation: "revise" | "save"; journeyId: string; revision: number; capability: string; fieldIds: string[];
};
export type AgentLaunch = { action: AgentAction; values: InputValues; sourceExperienceId: string } | { capability: CapabilityRef };
export const customerEventSchema = z.object({
  eventId: key, type: z.literal("account.first_deposit.completed"), personaId: key,
}).strict();

export const amountCentsMax = 10_000_000;
export const addressFields = ["street", "city", "region", "postalCode"] as const;
