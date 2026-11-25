import { z } from "zod";
import { recommendationDomainSchema } from "./recommendation-provider";

export const actionFlowTargetKindSchema = z.enum(["external_connector", "domain_write", "ui_layout"]);
export const actionFlowApprovalModeSchema = z.enum(["auto_execute", "hitl_inline", "hitl_4eyes"]);

export const actionFlowSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{1,47}$/),
  name: z.string().trim().min(1).max(80),
  domain: recommendationDomainSchema,
  description: z.string().trim().min(1).max(240),
  triggerPhrases: z.array(z.string().trim().min(2).max(120)).min(1).max(8),
  targetKind: actionFlowTargetKindSchema,
  connectorId: z.string().trim().max(64).optional(),
  connectorAction: z.string().trim().max(64).optional(),
  uiLayoutId: z.string().trim().max(64).optional(),
  approvalMode: actionFlowApprovalModeSchema.default("hitl_inline"),
  enabled: z.boolean().default(true),
  updatedAt: z.string().trim().min(1).max(64),
}).strict();

export const actionFlowUpsertSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{1,47}$/).optional(),
  name: z.string().trim().min(1).max(80),
  domain: recommendationDomainSchema,
  description: z.string().trim().min(1).max(240),
  triggerPhrases: z.array(z.string().trim().min(2).max(120)).min(1).max(8),
  targetKind: actionFlowTargetKindSchema,
  connectorId: z.string().trim().max(64).optional(),
  connectorAction: z.string().trim().max(64).optional(),
  uiLayoutId: z.string().trim().max(64).optional(),
  approvalMode: actionFlowApprovalModeSchema.default("hitl_inline"),
  enabled: z.boolean().default(true),
}).strict();

export type ActionFlowTargetKind = z.infer<typeof actionFlowTargetKindSchema>;
export type ActionFlowApprovalMode = z.infer<typeof actionFlowApprovalModeSchema>;
export type ActionFlow = z.infer<typeof actionFlowSchema>;
export type ActionFlowUpsertInput = z.input<typeof actionFlowUpsertSchema>;
