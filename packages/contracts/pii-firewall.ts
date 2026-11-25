import { z } from "zod";

export const piiCategorySchema = z.enum(["person", "amount", "account_id", "email", "phone", "ssn"]);
export type PiiCategory = z.infer<typeof piiCategorySchema>;

export const piiFirewallConfigSchema = z.object({
  enabled: z.boolean(),
  redactNames: z.boolean(),
  redactAmounts: z.boolean(),
  redactAccountIds: z.boolean(),
  redactEmailsPhones: z.boolean(),
}).strict();
export type PiiFirewallConfig = z.infer<typeof piiFirewallConfigSchema>;

export const piiTokenEntrySchema = z.object({
  token: z.string(),
  category: piiCategorySchema,
  original: z.string(),
  masked: z.string(),
}).strict();
export type PiiTokenEntry = z.infer<typeof piiTokenEntrySchema>;

export const piiRedactionTraceSchema = z.object({
  firewallEnabled: z.boolean(),
  redactedCount: z.number().int().min(0),
  originalPrompt: z.string(),
  scrubbedPrompt: z.string(),
  originalContextSummary: z.string().optional(),
  scrubbedContextSummary: z.string().optional(),
  tokens: z.array(piiTokenEntrySchema),
  rehydratedLocally: z.boolean(),
  timestamp: z.string(),
}).strict();
export type PiiRedactionTrace = z.infer<typeof piiRedactionTraceSchema>;

export interface PiiAuditEvent {
  id: string;
  turnId?: string;
  personaName?: string;
  firewallEnabled: boolean;
  redactedCount: number;
  categories: PiiCategory[];
  scrubbedPreview: string;
  timestamp: string;
}

export interface PiiFirewallView {
  config: PiiFirewallConfig;
  stats: {
    totalTurnsInspected: number;
    totalTurnsProtected: number;
    totalTokensRedacted: number;
  };
  recentEvents: PiiAuditEvent[];
}
