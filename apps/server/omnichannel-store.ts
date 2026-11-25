import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ApprovalRecord } from "../../packages/contracts/approval";
import {
  omnichannelConfigSchema,
  omnichannelDeliverySchema,
  type OmnichannelChannel,
  type OmnichannelConfig,
  type OmnichannelDelivery,
  type OmnichannelView,
} from "../../packages/contracts/omnichannel";
import { makeId } from "../../packages/experience/compile";

const defaultConfig: OmnichannelConfig = {
  enabled: true,
  channel: "slack",
  channelName: "#cep-approvals",
  webhookUrl: "",
  notifyOnPendingApproval: true,
  notifyOnTradeSettled: true,
  includeDigestBadge: true,
};

interface PersistedOmnichannel {
  config: OmnichannelConfig;
  deliveries: OmnichannelDelivery[];
}

export function buildSlackBlockKitPayload(input: {
  title: string;
  summary: string;
  riskLevel?: string;
  approvalId?: string;
  payloadDigest?: string;
  requester?: string;
  details?: { label: string; value: string }[];
  actionUrl: string;
  channelName: string;
}): Record<string, unknown> {
  const fields = (input.details ?? []).slice(0, 6).map((item) => ({
    type: "mrkdwn",
    text: `*${item.label}:*\n${item.value}`,
  }));
  const blocks: Record<string, unknown>[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `CEP Governance · ${input.title}`.slice(0, 140),
        emoji: true,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${input.summary}${input.requester ? `\n*Requested by:* ${input.requester}` : ""}`,
      },
    },
  ];
  if (fields.length > 0) {
    blocks.push({ type: "section", fields });
  }
  if (input.payloadDigest) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `SHA-256 Digest: \`${input.payloadDigest}\` · Risk: *${(input.riskLevel ?? "high").toUpperCase()}* · Channel: \`${input.channelName}\``,
        },
      ],
    });
  }
  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        style: "primary",
        text: { type: "plain_text", text: "Review & Approve in CEP" },
        url: input.actionUrl,
        action_id: `cep_approve_${input.approvalId ?? "preview"}`,
      },
      {
        type: "button",
        style: "danger",
        text: { type: "plain_text", text: "Reject Action" },
        url: input.actionUrl,
        action_id: `cep_reject_${input.approvalId ?? "preview"}`,
      },
    ],
  });
  return {
    channel: input.channelName,
    text: `CEP Approval Required: ${input.title}`,
    blocks,
  };
}

export function buildTeamsAdaptiveCardPayload(input: {
  title: string;
  summary: string;
  riskLevel?: string;
  approvalId?: string;
  payloadDigest?: string;
  requester?: string;
  details?: { label: string; value: string }[];
  actionUrl: string;
}): Record<string, unknown> {
  const facts = [
    ...(input.requester ? [{ title: "Requester", value: input.requester }] : []),
    ...(input.riskLevel ? [{ title: "Risk Tier", value: input.riskLevel.toUpperCase() }] : []),
    ...(input.details ?? []).slice(0, 6).map((item) => ({ title: item.label, value: item.value })),
    ...(input.payloadDigest ? [{ title: "SHA-256 Digest", value: input.payloadDigest }] : []),
  ];
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            {
              type: "TextBlock",
              size: "Medium",
              weight: "Bolder",
              text: `CEP Governance · ${input.title}`,
              wrap: true,
            },
            {
              type: "TextBlock",
              text: input.summary,
              wrap: true,
              isSubtle: true,
            },
            {
              type: "FactSet",
              facts,
            },
          ],
          actions: [
            {
              type: "Action.OpenUrl",
              title: "Review & Approve in CEP",
              url: input.actionUrl,
            },
          ],
        },
      },
    ],
  };
}

export class OmnichannelStore {
  private readonly filePath: string;
  private state: PersistedOmnichannel;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "omnichannel.json");
    this.state = this.load();
  }

  private load(): PersistedOmnichannel {
    if (existsSync(this.filePath)) {
      try {
        const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<PersistedOmnichannel>;
        const configParsed = omnichannelConfigSchema.safeParse(raw.config ?? defaultConfig);
        const deliveries = Array.isArray(raw.deliveries)
          ? raw.deliveries
              .map((item) => omnichannelDeliverySchema.safeParse(item))
              .filter((res): res is { success: true; data: OmnichannelDelivery } => res.success)
              .map((res) => res.data)
          : [];
        return {
          config: configParsed.success ? configParsed.data : { ...defaultConfig },
          deliveries: deliveries.slice(0, 50),
        };
      } catch { /* fall through */ }
    }
    const fresh: PersistedOmnichannel = { config: { ...defaultConfig }, deliveries: [] };
    this.save(fresh);
    return fresh;
  }

  private save(next: PersistedOmnichannel): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(next, null, 2), "utf8");
    this.state = next;
  }

  getConfig(): OmnichannelConfig {
    return { ...this.state.config };
  }

  updateConfig(input: Partial<OmnichannelConfig>): OmnichannelConfig {
    const parsed = omnichannelConfigSchema.parse({ ...this.state.config, ...input });
    this.save({ ...this.state, config: parsed });
    return { ...parsed };
  }

  private buildPayloadForChannel(
    channel: OmnichannelChannel,
    input: {
      title: string;
      summary: string;
      riskLevel?: string;
      approvalId?: string;
      payloadDigest?: string;
      requester?: string;
      details?: { label: string; value: string }[];
      actionUrl: string;
    },
  ): Record<string, unknown> {
    if (channel === "slack") {
      return buildSlackBlockKitPayload({ ...input, channelName: this.state.config.channelName });
    }
    if (channel === "teams") {
      return buildTeamsAdaptiveCardPayload(input);
    }
    return {
      event: "cep.governance.notification",
      channelName: this.state.config.channelName,
      timestamp: new Date().toISOString(),
      ...input,
    };
  }

  view(baseUrl = "http://127.0.0.1:4180"): OmnichannelView {
    const sampleInput = {
      title: "High-Value Equity Order · SELL 18 AAPL + Tax Harvest",
      summary: "Order gross value ($14,260.00) exceeds $10,000 automated threshold. SHA-256 payload digest locked for human approval.",
      riskLevel: "high",
      approvalId: "apr_sample_trade",
      payloadDigest: "a94f3c8e21b7d045e19a8c3f7b2104e2",
      requester: "Alice Morgan",
      details: [
        { label: "Legs", value: "SELL 18 AAPL + SELL 10 INTC" },
        { label: "Gross Value", value: "$14,260.00" },
        { label: "Tax Savings Est.", value: "$220.80" },
        { label: "Policy", value: "Trades > $10,000 require HITL" },
      ],
      actionUrl: `${baseUrl}/admin/logs?source=approvals`,
    };
    return {
      config: this.getConfig(),
      deliveries: this.state.deliveries.slice(0, 30),
      samplePayloads: {
        slack: buildSlackBlockKitPayload({ ...sampleInput, channelName: this.state.config.channelName }),
        teams: buildTeamsAdaptiveCardPayload(sampleInput),
      },
    };
  }

  private recordDelivery(delivery: OmnichannelDelivery): OmnichannelDelivery {
    const deliveries = [delivery, ...this.state.deliveries].slice(0, 50);
    this.save({ ...this.state, deliveries });
    return delivery;
  }

  private async dispatchWebhook(url: string, payload: Record<string, unknown>): Promise<{ ok: boolean; statusCode?: number }> {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
        return { ok: false, statusCode: 400 };
      }
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(4000),
      });
      return { ok: response.ok, statusCode: response.status };
    } catch {
      return { ok: false };
    }
  }

  notifyApprovalSync(approval: ApprovalRecord, baseUrl = "http://127.0.0.1:4180"): OmnichannelDelivery | null {
    const cfg = this.state.config;
    if (!cfg.enabled || !cfg.notifyOnPendingApproval) return null;
    const payload = this.buildPayloadForChannel(cfg.channel, {
      title: approval.title,
      summary: approval.summary,
      riskLevel: approval.riskLevel,
      approvalId: approval.id,
      payloadDigest: cfg.includeDigestBadge ? approval.payloadDigest : undefined,
      requester: approval.requester,
      details: approval.details,
      actionUrl: `${baseUrl}/admin/logs?source=approvals`,
    });
    const entry = this.recordDelivery({
      id: makeId("omni"),
      timestamp: new Date().toISOString(),
      channel: cfg.channel,
      channelName: cfg.channelName,
      eventType: "approval.pending",
      title: approval.title,
      summary: approval.summary,
      status: cfg.webhookUrl ? "delivered" : "sandbox_preview",
      approvalId: approval.id,
      payloadPreview: payload,
    });
    if (cfg.webhookUrl) {
      void this.dispatchWebhook(cfg.webhookUrl, payload).then((result) => {
        const updated = this.state.deliveries.map((item) => item.id === entry.id
          ? { ...item, status: result.ok ? "delivered" as const : "failed" as const, ...(result.statusCode ? { statusCode: result.statusCode } : {}) }
          : item);
        this.save({ ...this.state, deliveries: updated });
      });
    }
    return entry;
  }

  async sendTestNotification(baseUrl = "http://127.0.0.1:4180"): Promise<{ delivery: OmnichannelDelivery; view: OmnichannelView }> {
    const cfg = this.state.config;
    const payload = this.buildPayloadForChannel(cfg.channel, {
      title: "Test Governance Alert · High-Value Order Approval",
      summary: "Synthetic test dispatch from CEP Admin Embed & Omnichannel Studio verifying Slack/Teams card formatting and SHA-256 digest binding.",
      riskLevel: "high",
      approvalId: "apr_test_preview",
      payloadDigest: cfg.includeDigestBadge ? "e81d7b4a0c329f15a4b82c7d9e0311f4" : undefined,
      requester: "CEP Platform Admin",
      details: [
        { label: "Channel", value: cfg.channelName },
        { label: "Format", value: cfg.channel === "slack" ? "Slack Block Kit" : cfg.channel === "teams" ? "MS Teams Adaptive Card v1.4" : "JSON Webhook" },
        { label: "Target", value: cfg.webhookUrl || "Sandbox Preview (local)" },
      ],
      actionUrl: `${baseUrl}/admin/logs?source=approvals`,
    });
    let status: OmnichannelDelivery["status"] = "sandbox_preview";
    let statusCode: number | undefined;
    if (cfg.webhookUrl) {
      const result = await this.dispatchWebhook(cfg.webhookUrl, payload);
      status = result.ok ? "delivered" : "failed";
      statusCode = result.statusCode;
    }
    const delivery = this.recordDelivery({
      id: makeId("omni"),
      timestamp: new Date().toISOString(),
      channel: cfg.channel,
      channelName: cfg.channelName,
      eventType: "test.ping",
      title: "Test Governance Alert · High-Value Order Approval",
      summary: `Dispatched ${cfg.channel.toUpperCase()} payload to ${cfg.channelName} (${status.replace("_", " ")}).`,
      status,
      ...(statusCode ? { statusCode } : {}),
      payloadPreview: payload,
    });
    return { delivery, view: this.view(baseUrl) };
  }
}
