/**
 * Multimodal Document-to-Action turn handler (`[Attached: ...]`).
 * Extracted from `apps/server/service.ts` to keep turn orchestration decoupled
 * from document parsing and vertical action-canvas composition.
 */
import { DECISION_TTL } from "../../../packages/contracts/domain";
import type { SemanticRouteTrace } from "../../../packages/contracts/api";
import type { PersonaRecord } from "../../../packages/customer-profiles";
import { compileDynamicCanvas } from "../../../packages/experience/compile";
import type { ApprovalStore } from "../approval-store";
import { extractDocumentAction } from "../document-extractor";
import { generateDynamicUi } from "../dynamic-ui-generator";
import type { GatewaySettings } from "../gateway";
import type { ConversationRecord } from "../store";
import type { SettlementCallback, TradeStore } from "../trade-store";
import type { WorkflowEngine } from "../workflow-engine";

export interface DocumentActionInput {
  attachedDoc: { fileName: string; body: string };
  message: string;
  conversation: ConversationRecord;
  principalId: string;
  operatorName?: string;
  persona?: PersonaRecord;
  gateway?: GatewaySettings | null;
  dataDir: string;
  workflowEngine?: WorkflowEngine;
  tradeStore?: TradeStore;
  approvalStore?: ApprovalStore;
  onTradeSettle?: (principalId: string) => SettlementCallback;
  allows: (cap: "stock_trade" | "ops_incident") => boolean;
  onProgress: () => void;
  now: () => number;
  signal: AbortSignal;
}

export interface DocumentActionOutput {
  result: ReturnType<typeof compileDynamicCanvas>;
  semanticRoute: SemanticRouteTrace;
  completedAt: number;
}

export async function handleAttachedDocumentTurn(
  input: DocumentActionInput,
): Promise<DocumentActionOutput | null> {
  const {
    attachedDoc, message, conversation, principalId, operatorName, persona,
    gateway, dataDir, workflowEngine, tradeStore, approvalStore, onTradeSettle,
    allows, onProgress, now, signal,
  } = input;

  const extracted = await extractDocumentAction({
    fileName: attachedDoc.fileName,
    content: attachedDoc.body,
    gateway,
    dataDir,
    signal,
  });
  if (!extracted) return null;

  onProgress();
  const completedAt = now();

  if (extracted.actionType === "wire_workflow" && operatorName && workflowEngine) {
    const started = await workflowEngine.startRun("wire_transfer_governed", {
      personaId: conversation.personaId,
      actorName: persona?.displayName ?? "Customer",
      conversationId: conversation.id,
      initialInputs: extracted.extractedFields,
    });
    const canvas = {
      title: `Document-to-Action · ${started.definition.name}`,
      badge: `Extracted from ${extracted.fileName}`,
      subtitle: extracted.summary,
      generatedBy: "synthesizer" as const,
      dataSource: `Document Extractor (${extracted.fileName}) → Workflow Engine`,
      recordId: started.run.runId,
      prompt: message,
      nodes: [
        {
          type: "callout" as const,
          tone: "highlight" as const,
          title: `Auto-Extracted Fields from ${extracted.fileName}`,
          body: `Recipient: ${extracted.extractedFields.recipientName} · Amount: $${extracted.extractedFields.amountUsd.toLocaleString("en-US")} · Rail: ${extracted.extractedFields.rail}. Pre-populated below for verification.`,
        },
        {
          type: "workflow_runner" as const,
          runId: started.run.runId,
          workflowId: started.definition.id,
          workflowName: started.definition.name,
        },
      ],
      disclaimer: "Document fields extracted automatically. Review pre-filled inputs before continuing through compliance gates.",
    };
    return {
      result: compileDynamicCanvas(
        `Extracted wire payment details from **${extracted.fileName}** and pre-populated the **Governed Wire Transfer Pipeline** below.`,
        canvas,
        completedAt + DECISION_TTL,
      ),
      semanticRoute: {
        capabilityId: "external_connector",
        capabilityLabel: "Document-to-Action · Wire Workflow",
        method: "deterministic",
        confidence: extracted.confidence,
        reasoning: extracted.summary,
      },
      completedAt,
    };
  }

  if (extracted.actionType === "stock_trade" && allows("stock_trade") && tradeStore) {
    const syntheticPrompt = `${extracted.extractedFields.side} ${
      extracted.extractedFields.percent ? `${extracted.extractedFields.percent}%` : `${extracted.extractedFields.shares ?? 10} shares`
    } of ${extracted.extractedFields.symbol}`;
    const generated = await generateDynamicUi({
      prompt: syntheticPrompt,
      gateway,
      dataDir,
      tradeStore,
      approvalStore,
      personaId: conversation.personaId,
      conversationId: conversation.id,
      principalId,
      onTradeSettle,
      requesterName: operatorName ?? persona?.displayName,
      semanticRoute: {
        capabilityId: "stock_trade",
        capabilityLabel: "Document-to-Action · Equity Order",
        method: "deterministic",
        confidence: extracted.confidence,
        reasoning: extracted.summary,
        extractedParams: extracted.extractedFields,
      },
      signal,
    });
    return {
      result: compileDynamicCanvas(
        `Extracted order instruction from **${extracted.fileName}**: ${extracted.summary}`,
        generated.canvas,
        completedAt + DECISION_TTL,
      ),
      semanticRoute: {
        capabilityId: "stock_trade",
        capabilityLabel: "Document-to-Action · Equity Order",
        method: "deterministic",
        confidence: extracted.confidence,
        reasoning: extracted.summary,
      },
      completedAt,
    };
  }

  if (extracted.actionType === "ops_incident" && allows("ops_incident")) {
    const canvas = {
      title: `Document-to-Action · Outage Log Triage (${extracted.extractedFields.serviceName})`,
      badge: `Parsed ${extracted.fileName}`,
      subtitle: extracted.summary,
      generatedBy: "synthesizer" as const,
      dataSource: `Log Extractor (${extracted.fileName}) + Live Incident Store`,
      prompt: message,
      nodes: [
        {
          type: "metrics" as const,
          items: [
            { label: "Service", value: extracted.extractedFields.serviceName },
            { label: "5xx Error Rate", value: `${extracted.extractedFields.errorRatePct}%`, delta: "Above 2.0% P1 threshold" },
            { label: "p95 Latency", value: `${extracted.extractedFields.p95LatencyMs}ms`, delta: "Above 350ms SLO" },
            { label: "Release", value: extracted.extractedFields.releaseTag },
          ],
        },
        {
          type: "callout" as const,
          tone: "caution" as const,
          title: `Extracted Log Evidence (${extracted.fileName})`,
          body: extracted.extractedFields.logExcerpt,
        },
      ],
      disclaimer: "Parsed from uploaded diagnostic log. Trigger the P1 rollback workflow or PagerDuty connector for governed remediation.",
      suggestedFollowUp: "Build an IT incident triage dashboard for our active P1 alert",
    };
    return {
      result: compileDynamicCanvas(
        `Analyzed **${extracted.fileName}** and extracted live P1 outage telemetry for **${extracted.extractedFields.serviceName}** (${extracted.extractedFields.releaseTag}).`,
        canvas,
        completedAt + DECISION_TTL,
      ),
      semanticRoute: {
        capabilityId: "ops_incident",
        capabilityLabel: "Document-to-Action · Outage Log Triage",
        method: "deterministic",
        confidence: extracted.confidence,
        reasoning: extracted.summary,
      },
      completedAt,
    };
  }

  return null;
}
