import { z } from "zod";

export const proactiveEventTypeSchema = z.enum([
  "market.price_alert",
  "portfolio.large_deposit",
  "ops.latency_spike",
  "sales.deal_at_risk",
  "custom.event",
]);
export type ProactiveEventType = z.infer<typeof proactiveEventTypeSchema>;

export const proactiveAlertSchema = z.object({
  id: z.string(),
  eventType: proactiveEventTypeSchema,
  severity: z.enum(["info", "opportunity", "critical"]),
  domain: z.enum(["wealth", "it_ops", "sales_revops"]),
  title: z.string(),
  summary: z.string(),
  metricLabel: z.string(),
  metricValue: z.string(),
  ctaLabel: z.string(),
  ctaPrompt: z.string(),
  personaId: z.string(),
  createdAt: z.string(),
  dismissed: z.boolean().default(false),
});
export type ProactiveAlert = z.infer<typeof proactiveAlertSchema>;

export const proactiveTriggerInputSchema = z.object({
  eventType: proactiveEventTypeSchema,
  personaId: z.string().trim().max(64).optional(),
  title: z.string().trim().max(120).optional(),
  summary: z.string().trim().max(300).optional(),
  metricLabel: z.string().trim().max(48).optional(),
  metricValue: z.string().trim().max(48).optional(),
  ctaLabel: z.string().trim().max(48).optional(),
  ctaPrompt: z.string().trim().max(220).optional(),
}).strict();
export type ProactiveTriggerInput = z.infer<typeof proactiveTriggerInputSchema>;

export interface ProactiveView {
  alerts: ProactiveAlert[];
  activeCount: number;
}
