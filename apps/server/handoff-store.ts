/**
 * Live Human Agent Warm Handoff store (item 2.6):
 * Escalates customer conversations into an advisor/agent inbox with a structured brief, Customer 360 snapshot,
 * and recent transcript, and lets a human advisor claim, reply back into the customer thread, and resolve.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  handoffTicketSchema,
  type HandoffInboxView,
  type HandoffPriority,
  type HandoffTicket,
} from "../../packages/contracts/handoff";
import type { RecommendationDomain } from "../../packages/contracts/recommendation-provider";

const HANDOFF_TRIGGER_RE = /\b(talk to (a |an )?(human|person|advisor|agent|representative|someone)|speak (to|with) (a |an )?(human|person|advisor|agent|representative)|live (agent|advisor|support|human)|escalate (to|this to) (a |an )?(human|advisor|agent)|transfer (me )?to (a |an )?(human|advisor|agent))\b/i;

export function isHandoffRequest(message: string): boolean {
  return HANDOFF_TRIGGER_RE.test(message);
}

export class HandoffStore {
  private readonly filePath: string;
  private tickets: HandoffTicket[];

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "handoffs.json");
    this.tickets = this.load();
  }

  private load(): HandoffTicket[] {
    if (!existsSync(this.filePath)) return [];
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
      if (!Array.isArray(raw)) return [];
      return raw.flatMap((item) => {
        const parsed = handoffTicketSchema.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      });
    } catch {
      return [];
    }
  }

  private save(next: HandoffTicket[]) {
    mkdirSync(dirname(this.filePath), { recursive: true });
    this.tickets = next.slice(0, 100);
    writeFileSync(this.filePath, JSON.stringify(this.tickets, null, 2), "utf8");
  }

  findById(handoffId: string): HandoffTicket | undefined {
    return this.tickets.find((t) => t.handoffId === handoffId);
  }

  findOpenForConversation(conversationId: string): HandoffTicket | undefined {
    return this.tickets.find((t) => t.conversationId === conversationId && t.status !== "resolved");
  }

  create(input: {
    conversationId: string;
    personaId: string;
    customerName: string;
    domain: RecommendationDomain;
    reason: string;
    priority?: HandoffPriority;
    customerSnapshot: Record<string, string>;
    recentTranscript: Array<{ role: "user" | "assistant"; text: string }>;
  }): HandoffTicket {
    const existing = this.findOpenForConversation(input.conversationId);
    if (existing) return existing;

    const now = new Date().toISOString();
    const priority: HandoffPriority = input.priority
      ?? (/\b(urgent|fraud|unauthorized|outage|p1|locked|emergency)\b/i.test(input.reason) ? "urgent"
        : /\b(wire|tax|trade|complaint|dispute|beneficiary)\b/i.test(input.reason) ? "high" : "normal");

    const snapParts = Object.entries(input.customerSnapshot).slice(0, 6).map(([k, v]) => `${k}: ${v}`);
    const lastUser = [...input.recentTranscript].reverse().find((m) => m.role === "user")?.text;
    const aiBrief = [
      `Customer ${input.customerName} (${input.domain}) requested a live specialist: "${input.reason.slice(0, 180)}".`,
      snapParts.length ? `Snapshot — ${snapParts.join(" · ")}.` : "",
      lastUser ? `Latest message: "${lastUser.slice(0, 180)}".` : "",
    ].filter(Boolean).join(" ");

    const ticket = handoffTicketSchema.parse({
      handoffId: `hnd_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
      conversationId: input.conversationId,
      personaId: input.personaId,
      customerName: input.customerName,
      domain: input.domain,
      reason: input.reason.slice(0, 400),
      priority,
      status: "queued",
      aiBrief,
      customerSnapshot: input.customerSnapshot,
      recentTranscript: input.recentTranscript.slice(-10).map((m) => ({ role: m.role, text: m.text.slice(0, 600) })),
      notes: [
        {
          id: `hn_${randomUUID().slice(0, 8)}`,
          author: "CEP Concierge",
          role: "system",
          text: `Warm handoff created with full conversation context and ${Object.keys(input.customerSnapshot).length} Customer 360 signals.`,
          createdAt: now,
        },
      ],
      createdAt: now,
      updatedAt: now,
    });
    this.save([ticket, ...this.tickets]);
    return ticket;
  }

  claim(handoffId: string, agentName: string): HandoffTicket | undefined {
    const existing = this.findById(handoffId);
    if (!existing) return undefined;
    const now = new Date().toISOString();
    const updated: HandoffTicket = {
      ...existing,
      status: "claimed",
      assignedAgent: agentName.slice(0, 80),
      claimedAt: existing.claimedAt ?? now,
      updatedAt: now,
      notes: [
        ...existing.notes,
        { id: `hn_${randomUUID().slice(0, 8)}`, author: agentName.slice(0, 80), role: "system", text: `${agentName} joined the conversation.`, createdAt: now },
      ],
    };
    this.save(this.tickets.map((t) => (t.handoffId === handoffId ? updated : t)));
    return updated;
  }

  addReply(handoffId: string, author: string, text: string, role: "agent" | "customer" = "agent"): HandoffTicket | undefined {
    const existing = this.findById(handoffId);
    if (!existing) return undefined;
    const now = new Date().toISOString();
    const updated: HandoffTicket = {
      ...existing,
      status: role === "agent" && existing.status === "queued" ? "claimed" : existing.status,
      assignedAgent: role === "agent" ? (existing.assignedAgent ?? author.slice(0, 80)) : existing.assignedAgent,
      claimedAt: role === "agent" ? (existing.claimedAt ?? now) : existing.claimedAt,
      updatedAt: now,
      notes: [
        ...existing.notes,
        { id: `hn_${randomUUID().slice(0, 8)}`, author: author.slice(0, 80), role, text: text.trim().slice(0, 2000), createdAt: now },
      ],
    };
    this.save(this.tickets.map((t) => (t.handoffId === handoffId ? updated : t)));
    return updated;
  }

  resolve(handoffId: string, agentName: string, resolutionNote?: string): HandoffTicket | undefined {
    const existing = this.findById(handoffId);
    if (!existing) return undefined;
    const now = new Date().toISOString();
    const updated: HandoffTicket = {
      ...existing,
      status: "resolved",
      assignedAgent: existing.assignedAgent ?? agentName.slice(0, 80),
      resolvedAt: now,
      updatedAt: now,
      notes: [
        ...existing.notes,
        {
          id: `hn_${randomUUID().slice(0, 8)}`,
          author: agentName.slice(0, 80),
          role: "system",
          text: `Resolved by ${agentName}${resolutionNote ? `: ${resolutionNote.slice(0, 300)}` : "."}`,
          createdAt: now,
        },
      ],
    };
    this.save(this.tickets.map((t) => (t.handoffId === handoffId ? updated : t)));
    return updated;
  }

  view(): HandoffInboxView {
    return {
      tickets: this.tickets,
      queuedCount: this.tickets.filter((t) => t.status === "queued").length,
      claimedCount: this.tickets.filter((t) => t.status === "claimed").length,
      resolvedCount: this.tickets.filter((t) => t.status === "resolved").length,
    };
  }
}
