import { z } from "zod";
import type { CustomerLookupSummary, NextBestActionCard } from "./api";

export const customAttributeTypeSchema = z.enum(["text", "currency", "number", "percent"]);
export type CustomAttributeType = z.infer<typeof customAttributeTypeSchema>;

export const customAttributeSchema = z.object({
  key: z.string().trim().regex(/^[a-z][a-z0-9_]{0,47}$/, "Use lowercase snake_case (e.g. risk_tolerance)"),
  label: z.string().trim().min(1).max(60),
  type: customAttributeTypeSchema,
  value: z.string().trim().max(160),
}).strict();
export type CustomAttribute = z.infer<typeof customAttributeSchema>;

export const customer360ProfileInputSchema = z.object({
  personaId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).optional(),
  displayName: z.string().trim().min(1, "Display name is required").max(80),
  segment: z.string().trim().max(80),
  notes: z.string().trim().max(400),
  accountFundingStatus: z.enum(["funded", "unfunded"]),
  beneficiaryStatus: z.enum(["on_file", "missing"]),
  availableBalanceCents: z.number().int().min(0).max(1_000_000_000_00),
  currentBalanceCents: z.number().int().min(0).max(1_000_000_000_00),
  cashCents: z.number().int().min(0).max(1_000_000_000_00),
  equityCents: z.number().int().min(0).max(1_000_000_000_00),
  fixedIncomeCents: z.number().int().min(0).max(1_000_000_000_00),
  homeGoalTargetCents: z.number().int().min(0).max(1_000_000_000_00),
  homeGoalSavedCents: z.number().int().min(0).max(1_000_000_000_00),
  customAttributes: z.array(customAttributeSchema).max(20).optional(),
}).strict();

export type Customer360ProfileInput = z.infer<typeof customer360ProfileInputSchema>;

export const storedCustomerProfileSchema = customer360ProfileInputSchema.extend({
  personaId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  syntheticMid: z.string().min(1).max(64),
  allowedScenarios: z.array(z.string().min(1)).min(1),
  updatedAt: z.string(),
}).strict();

export type StoredCustomerProfile = z.infer<typeof storedCustomerProfileSchema>;

export type Customer360AdminRecord = StoredCustomerProfile & {
  isBuiltIn: boolean;
  isCustomized: boolean;
  dismissedNbaIds: string[];
  lookup: CustomerLookupSummary;
  nba?: NextBestActionCard;
};
