import { z } from "zod";

export const omnichannelChannelSchema = z.enum(["slack", "teams", "webhook"]);
export type OmnichannelChannel = z.infer<typeof omnichannelChannelSchema>;

export const omnichannelConfigSchema = z.object({
  enabled: z.boolean().default(true),
  channel: omnichannelChannelSchema.default("slack"),
  channelName: z.string().trim().min(1).max(80).default("#cep-approvals"),
  webhookUrl: z.string().trim().max(300).default(""),
  notifyOnPendingApproval: z.boolean().default(true),
  notifyOnTradeSettled: z.boolean().default(true),
  includeDigestBadge: z.boolean().default(true),
});
export type OmnichannelConfig = z.infer<typeof omnichannelConfigSchema>;

export const omnichannelDeliveryStatusSchema = z.enum(["delivered", "sandbox_preview", "failed"]);
export type OmnichannelDeliveryStatus = z.infer<typeof omnichannelDeliveryStatusSchema>;

export const omnichannelDeliverySchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  channel: omnichannelChannelSchema,
  channelName: z.string(),
  eventType: z.enum(["approval.pending", "trade.settled", "test.ping"]),
  title: z.string(),
  summary: z.string(),
  status: omnichannelDeliveryStatusSchema,
  statusCode: z.number().int().optional(),
  approvalId: z.string().optional(),
  payloadPreview: z.record(z.string(), z.unknown()),
});
export type OmnichannelDelivery = z.infer<typeof omnichannelDeliverySchema>;

export interface OmnichannelView {
  config: OmnichannelConfig;
  deliveries: OmnichannelDelivery[];
  samplePayloads: {
    slack: Record<string, unknown>;
    teams: Record<string, unknown>;
  };
}
