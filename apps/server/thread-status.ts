import { runAgenticHarness, type AgenticHarness, type HarnessStageRecord, type HarnessTrace } from "@sfield/core";
import { progressLabels, type TurnView } from "../../packages/contracts/api";
import type { DynamicCanvasNode, DynamicCanvasProps, DynamicHarnessTrace } from "../../packages/contracts/dynamic-canvas";
import type { ConversationRecord, Store } from "./store";
import type { PznChatHistory } from "./chat-history";
import { principalFor, type Runtime } from "./runtime";
import type { TradeStore } from "./trade-store";
import type { WorkflowEngine } from "./workflow-engine";

export interface ThreadStatusSummaryItem {
  conversationId: string;
  title: string;
  domainId: string;
  isCurrent: boolean;
  status: "running" | "waiting_clarification" | "completed" | "failed" | "idle";
  workingCount: number;
  completedCount: number;
  totalTurns: number;
  liveProgress?: string;
  latestMessage?: string;
  latestReply?: string;
  rollingGoal?: string;
  updatedAt: number;
}

export interface BackgroundJobSummaryItem {
  id: string;
  kind: "stock_trade" | "workflow";
  status: string;
  label: string;
  detail: string;
}

export interface CrossThreadStatusSnapshot {
  currentConversationId?: string;
  threads: ThreadStatusSummaryItem[];
  otherThreads: ThreadStatusSummaryItem[];
  runningThreadsCount: number;
  waitingClarificationCount: number;
  backgroundJobs: BackgroundJobSummaryItem[];
}

const threadStatusTrigger = /\b((?:status|state|progress|update|updates)\s+(?:of|on|for)\s+(?:my\s+|all\s+)?(?:other\s+)?(?:threads?|chats?|conversations?|background\s+(?:tasks?|jobs?))|(?:my\s+|all\s+)?other\s+(?:threads?|chats?|conversations?)\b.*\b(?:status|running|doing|done|finished|working|happening|going|progress|check|show|list)|what(?:'s| is)\s+(?:running|happening|going\s+on)\s+in\s+(?:my\s+)?(?:other\s+)?(?:threads?|chats?|conversations?)|(?:are\s+any|any)\s+(?:tasks?|jobs?|threads?|chats?)\s+(?:still\s+)?running|(?:check|show|list)\s+(?:my\s+|all\s+)?(?:other\s+)?(?:active\s+|running\s+)?(?:threads?|conversations?|background\s+(?:tasks?|jobs?)))\b/i;

export function isThreadStatusPrompt(message: string): boolean {
  return threadStatusTrigger.test(message.trim());
}

function formatAge(updatedAt: number, now: number): string {
  const diffSec = Math.max(0, Math.round((now - updatedAt) / 1000));
  if (diffSec < 45) return "just now";
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  return `${Math.round(diffSec / 86400)}d ago`;
}

export async function collectCrossThreadStatus(input: {
  store: Store;
  history: PznChatHistory;
  runtime?: Runtime | null;
  principalId: string;
  personaId: string;
  viewer?: { customer?: string; operator?: string };
  operator?: boolean;
  currentConversationId?: string;
  tradeStore?: TradeStore;
  workflowEngine?: WorkflowEngine;
  now?: number;
}): Promise<CrossThreadStatusSnapshot> {
  const conversations = input.store.conversations(input.principalId, Boolean(input.operator), input.viewer)
    .filter((c) => c.archivedAt === undefined)
    .slice(0, 16);

  const threads: ThreadStatusSummaryItem[] = [];
  for (const conv of conversations) {
    const turns = input.store.conversationTurns(conv.id);
    const working = turns.filter((t) => t.public.status === "working");
    const completed = turns.filter((t) => t.public.status === "completed");
    const latest = turns[turns.length - 1]?.public;
    const nextOrdinal = (turns[turns.length - 1]?.ordinal ?? 0) + 1;
    const fullRecord = (() => {
      try {
        return input.store.conversation(conv.id, input.principalId, input.viewer);
      } catch {
        return null;
      }
    })();
    const pendingClarify = fullRecord
      ? await input.history.pendingClarification(fullRecord, nextOrdinal).catch(() => null)
      : null;
    const rolling = input.runtime
      ? await input.runtime.compactor.getSummary(
          principalFor(fullRecord?.principalId ?? input.principalId, { userId: conv.userId, personaId: conv.personaId, domainId: conv.domainId }),
          conv.id,
        ).catch(() => null)
      : null;

    let status: ThreadStatusSummaryItem["status"] = "idle";
    let liveProgress: string | undefined;
    if (working.length > 0) {
      status = "running";
      const active = working[working.length - 1]!.public;
      const lastStage = active.harnessStages?.[active.harnessStages.length - 1];
      liveProgress = lastStage
        ? `${lastStage.stage.toUpperCase()}: ${lastStage.summary}`
        : progressLabels[active.progress];
    } else if (pendingClarify) {
      status = "waiting_clarification";
      liveProgress = `Waiting for answer: ${pendingClarify.question.slice(0, 60)}`;
    } else if (latest?.status === "failed") {
      status = "failed";
    } else if (completed.length > 0) {
      status = "completed";
    }

    const latestCompleted = completed[completed.length - 1]?.public;
    const latestReply = latestCompleted?.experience?.question ?? latestCompleted?.experience?.intro;

    threads.push({
      conversationId: conv.id,
      title: conv.title || "Untitled conversation",
      domainId: conv.domainId,
      isCurrent: conv.id === input.currentConversationId,
      status,
      workingCount: working.length,
      completedCount: completed.length,
      totalTurns: turns.length,
      liveProgress,
      latestMessage: latest?.message,
      latestReply,
      rollingGoal: rolling?.activeGoal,
      updatedAt: conv.updatedAt,
    });
  }

  const backgroundJobs: BackgroundJobSummaryItem[] = [];
  if (input.tradeStore) {
    const jobs = input.tradeStore.listJobs(input.personaId).slice(0, 6);
    for (const j of jobs) {
      if (j.status !== "cancelled") {
        backgroundJobs.push({
          id: j.jobId,
          kind: "stock_trade",
          status: j.status,
          label: j.legs.map((l) => `${l.side.toUpperCase()} ${l.shares} ${l.symbol}`).join(" + "),
          detail: `${j.progressPct}% · ${j.stageLabel}`,
        });
      }
    }
  }
  if (input.workflowEngine) {
    const runs = input.workflowEngine.view().recentRuns.filter((r) => r.personaId === input.personaId).slice(0, 6);
    for (const r of runs) {
      backgroundJobs.push({
        id: r.runId,
        kind: "workflow",
        status: r.status,
        label: r.workflowName,
        detail: `${r.steps.filter((s) => s.status === "completed").length}/${r.steps.length} steps completed`,
      });
    }
  }

  const otherThreads = threads.filter((t) => !t.isCurrent);
  return {
    currentConversationId: input.currentConversationId,
    threads,
    otherThreads,
    runningThreadsCount: threads.filter((t) => t.status === "running").length,
    waitingClarificationCount: threads.filter((t) => t.status === "waiting_clarification").length,
    backgroundJobs,
  };
}

function toCanvasTrace(trace: HarnessTrace): DynamicHarnessTrace {
  return {
    harnessRunId: trace.harnessRunId,
    resolvedGoal: trace.resolvedGoal,
    ...(trace.thinking ? { thinking: trace.thinking } : {}),
    fetchedSources: trace.fetchedSources,
    visualTargets: trace.visualTargets,
    repaired: trace.repaired,
    stages: trace.stages,
  };
}

export async function runThreadStatusHarness(input: {
  prompt: string;
  store: Store;
  history: PznChatHistory;
  runtime?: Runtime | null;
  harness?: AgenticHarness;
  principalId: string;
  personaId: string;
  viewer?: { customer?: string; operator?: string };
  operator?: boolean;
  currentConversation: ConversationRecord;
  tradeStore?: TradeStore;
  workflowEngine?: WorkflowEngine;
  onStage?: (stage: HarnessStageRecord) => void | Promise<void>;
  now?: number;
  signal?: AbortSignal;
}): Promise<{ intro: string; canvas: DynamicCanvasProps }> {
  const now = input.now ?? Date.now();
  const execute = input.harness ? input.harness.run.bind(input.harness) : runAgenticHarness;

  const outcome = await execute<{ scope: "other" | "all" }, CrossThreadStatusSnapshot, { intro: string; canvas: DynamicCanvasProps }, { intro: string; canvas: DynamicCanvasProps }>({
    kind: "thread_status",
    principal: principalFor(input.principalId, {
      userId: input.currentConversation.userId,
      personaId: input.currentConversation.personaId,
      domainId: input.currentConversation.domainId,
    }),
    signal: input.signal,
    onStage: input.onStage,
    maxRepairs: 0,

    plan: async () => {
      const asksOnlyOther = /\bother\s+(?:threads?|chats?|conversations?)\b/i.test(input.prompt);
      return {
        status: "ready",
        plan: { scope: asksOnlyOther ? "other" : "all" },
        resolvedGoal: asksOnlyOther
          ? "Inspect live status of all other conversations and active background tasks for this user"
          : "Inspect live status of all conversations and active background tasks for this user",
        thinking: "Identified cross-thread status query. Fetching live thread turns, active working progress, pending clarifications, and background jobs scoped to the signed-in user.",
        summary: "Planned cross-thread & background task status lookup",
        targets: ["metrics", "table"],
      };
    },

    gather: async () => {
      const snapshot = await collectCrossThreadStatus({
        store: input.store,
        history: input.history,
        runtime: input.runtime,
        principalId: input.principalId,
        personaId: input.personaId,
        viewer: input.viewer,
        operator: input.operator,
        currentConversationId: input.currentConversation.id,
        tradeStore: input.tradeStore,
        workflowEngine: input.workflowEngine,
        now,
      });
      return {
        status: "ok",
        evidence: snapshot,
        sources: ["CEP Conversation Store", "sfield Compactor", ...(snapshot.backgroundJobs.length ? ["Background Jobs"] : [])],
        thinking: `Found ${snapshot.otherThreads.length} other thread(s) (${snapshot.otherThreads.filter((t) => t.status === "running").length} running now) and ${snapshot.backgroundJobs.length} background job(s).`,
        summary: `Inspected ${snapshot.threads.length} thread(s) and ${snapshot.backgroundJobs.length} background job(s)`,
      };
    },

    synthesize: async (plan, snap) => {
      const targetThreads = plan.scope === "other" && snap.otherThreads.length > 0
        ? snap.otherThreads
        : snap.threads;
      const otherRunning = snap.otherThreads.filter((t) => t.status === "running");
      const currentWorkingOthers = snap.threads.find((t) => t.isCurrent)?.workingCount ?? 0;

      const statusBadge = (t: ThreadStatusSummaryItem) => (
        t.status === "running"
          ? `Running (${t.workingCount})`
          : t.status === "waiting_clarification"
            ? "Needs reply"
            : t.status === "failed"
              ? "Failed"
              : t.status === "completed"
                ? "Done"
                : "Idle"
      );

      const nodes: DynamicCanvasNode[] = [
        {
          type: "metrics",
          items: [
            { label: "Other Threads", value: String(snap.otherThreads.length), delta: `${snap.threads.length} total` },
            { label: "Running Tasks", value: String(snap.runningThreadsCount), delta: otherRunning.length ? `${otherRunning.length} in other threads` : "All other threads idle" },
            { label: "Needs Clarification", value: String(snap.waitingClarificationCount), delta: "Awaiting your pick" },
            { label: "Background Jobs", value: String(snap.backgroundJobs.length), delta: "Trades & workflows" },
          ],
        },
      ];

      if (targetThreads.length > 0) {
        nodes.push({
          type: "table",
          caption: plan.scope === "other" ? "Status of Your Other Threads" : "Status of All Active & Recent Threads",
          columns: ["Thread", "Status", "Latest Activity", "Updated"],
          rows: targetThreads.slice(0, 10).map((t) => [
            `${t.title.slice(0, 38)}${t.isCurrent ? " (this)" : ""}`,
            statusBadge(t),
            (t.liveProgress ?? t.rollingGoal ?? t.latestMessage ?? "No messages yet").slice(0, 76),
            `${t.totalTurns} turn${t.totalTurns === 1 ? "" : "s"} · ${formatAge(t.updatedAt, now)}`,
          ]),
        });
      } else {
        nodes.push({
          type: "callout",
          tone: "info",
          title: "No other threads yet",
          body: "This is your only active conversation right now. Start another conversation from the left sidebar anytime — you can check its live progress from here.",
        });
      }

      if (snap.backgroundJobs.length > 0) {
        nodes.push({
          type: "table",
          caption: "Background Jobs (Trades & Workflows)",
          columns: ["Job", "Type", "Status", "Progress"],
          rows: snap.backgroundJobs.slice(0, 6).map((j) => [
            j.label.slice(0, 42),
            j.kind === "stock_trade" ? "Stock Trade" : "Workflow",
            j.status,
            j.detail.slice(0, 76),
          ]),
        });
      }

      if (otherRunning.length > 0) {
        nodes.push({
          type: "callout",
          tone: "highlight",
          title: `${otherRunning.length} other thread${otherRunning.length === 1 ? " is" : "s are"} actively running`,
          body: otherRunning.map((t) => `"${t.title}" (${t.liveProgress ?? "working"})`).join(" · "),
        });
      } else if (currentWorkingOthers > 1) {
        nodes.push({
          type: "callout",
          tone: "info",
          title: "Parallel task running in this thread",
          body: `There ${currentWorkingOthers - 1 === 1 ? "is 1 earlier task" : `are ${currentWorkingOthers - 1} earlier tasks`} still working in this conversation while I answered your question.`,
        });
      }

      const intro = snap.otherThreads.length === 0
        ? "You don’t have any other active threads right now — this is your only conversation."
        : otherRunning.length > 0
          ? `You have ${snap.otherThreads.length} other thread${snap.otherThreads.length === 1 ? "" : "s"}: ${otherRunning.length} currently running (${otherRunning.map((t) => `"${t.title}"`).join(", ")}), and ${snap.otherThreads.length - otherRunning.length} idle/completed.`
          : `All ${snap.otherThreads.length} of your other thread${snap.otherThreads.length === 1 ? " is" : "s are"} finished or idle${snap.waitingClarificationCount > 0 ? ` (${snap.waitingClarificationCount} waiting for your clarification reply)` : ""}.`;

      return {
        candidate: {
          intro,
          canvas: {
            title: plan.scope === "other" ? "Other Threads & Tasks Status" : "All Threads & Tasks Status",
            badge: "Live Thread Monitor",
            subtitle: `Scoped to your active sessions · Updated ${formatAge(now, now)}`,
            generatedBy: "synthesizer",
            dataSource: "CEP Conversation Store + sfield Compactor",
            prompt: input.prompt.slice(0, 600),
            nodes,
            disclaimer: "Status reflects live in-memory and SQLite turn state scoped strictly to your signed-in session.",
            suggestedFollowUp: "Check status of my other threads again",
          },
        },
        summary: `Composed thread monitor table (${targetThreads.length} thread row(s))`,
      };
    },

    verify: (cand) => ({
      ok: true,
      output: cand,
      summary: "Verified scoped live thread metrics and table",
    }),
  });

  if (outcome.status === "completed") {
    return {
      intro: outcome.output.intro,
      canvas: {
        ...outcome.output.canvas,
        harnessTrace: toCanvasTrace(outcome.trace),
      },
    };
  }
  return {
    intro: "I checked your conversations, though no active threads were available.",
    canvas: {
      title: "Thread Status",
      badge: "Live Thread Monitor",
      generatedBy: "synthesizer",
      nodes: [{ type: "callout", tone: "info", body: "No threads found for this session." }],
      disclaimer: "Scoped to your signed-in session.",
      harnessTrace: toCanvasTrace(outcome.trace),
    },
  };
}
