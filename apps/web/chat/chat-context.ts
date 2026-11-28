/**
 * Shared chat context, formatting helpers, and wealth DOM context builder.
 * Extracted from `apps/web/main.tsx` for clean separation of concerns.
 */
import { createContext } from "react";
import type { ThreadMessageLike } from "@assistant-ui/react";
import { failureCopy, type DemoPersona, type Progress, type TurnView } from "../../../packages/contracts/api";
import type { ExpertiseMode } from "../../../packages/contracts/nextgen-chat";
import { formatPortfolioAmount } from "../../../packages/contracts/portfolio";
import type { CepEmbedScreenContext } from "../../../packages/embed-sdk";
import { planningTopics } from "../planning-topics";
import type { WorkspaceSection } from "../workspace-menu";

export const homeGoalPrompt = "Show my home-buying goal and savings progress.";
export const portfolioPrompt = planningTopics.find(({ id }) => id === "portfolio")!.prompt;
export const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

export type ConversationOperations = {
  latest?: TurnView;
  pending: boolean;
  adminChat: boolean;
  activeProfile?: DemoPersona;
  progressHistory: Record<string, Progress[]>;
  expertiseMode: ExpertiseMode;
  pinnedTurnId?: string;
  pinCanvas: (turn: TurnView) => void;
  branchTurn?: (turn: TurnView) => void;
  retry: (id: string) => void;
  followTurn: (id: string, message: HTMLElement, replyReady: boolean, goalSourceTurnId?: string) => (() => void) | undefined;
  feedback: (turnId: string, experienceId: string, value: "helpful" | "unhelpful") => void;
  runPrompt: (prompt: string) => void;
  previewFunding: () => void;
};

export const ConversationControls = createContext<ConversationOperations>({
  pending: false,
  adminChat: false,
  progressHistory: {},
  expertiseMode: "standard",
  pinCanvas: () => undefined,
  retry: () => undefined,
  feedback: () => undefined,
  followTurn: () => undefined,
  runPrompt: () => undefined,
  previewFunding: () => undefined,
});

export function visibleMessages(turns: TurnView[]): ThreadMessageLike[] {
  return turns.flatMap((turn): ThreadMessageLike[] => {
    const { id, experience, status, failureCode } = turn;
    const display = experience ?? (turn.previewExperience && { ...turn.previewExperience, previewTurnId: id });
    const terminalText = status === "failed" ? failureCopy[failureCode ?? "internal_error"] : status === "cancelled" ? "Response stopped." : "";
    return [
      { id: id + "_user", role: "user", content: turn.message, createdAt: new Date(turn.createdAt) },
      {
        // Keep the same chat row when the server delivers its completed A2UI surface.
        id: id + "_assistant",
        role: "assistant", createdAt: new Date(turn.createdAt),
        content: display ? [{ type: "data", name: "experience-surface", data: display },
          ...(terminalText ? [{ type: "text" as const, text: terminalText }] : [])] : terminalText,
        status: status === "working" ? { type: "running" } : { type: "complete", reason: "stop" },
        metadata: { custom: { turn } },
      },
    ];
  });
}

export function messageFor(error: unknown) {
  return error instanceof Error && error.name !== "TypeError" ? error.message : "Couldn’t connect. Your draft is still here.";
}

/** What the customer sees above the chat: a plain-language snapshot of the screen they're on, plus a few next steps. */
export function buildWealthDomContext(section: WorkspaceSection, profile?: DemoPersona): CepEmbedScreenContext | null {
  if (!profile) return null;
  const p = profile.overview?.portfolio;
  const totalCents = p ? p.cashCents + p.equityCents + p.fixedIncomeCents : 0;
  const cashLabel = p ? formatPortfolioAmount(p.cashCents) : "$0";
  const equityLabel = p ? formatPortfolioAmount(p.equityCents) : "$0";
  const fixedLabel = p ? formatPortfolioAmount(p.fixedIncomeCents) : "$0";
  const totalLabel = p ? formatPortfolioAmount(totalCents) : "$0";
  const goal = profile.overview?.homeGoal;
  const savedCents = goal?.history.at(-1)?.savedCents ?? 0;
  const goalPct = goal && goal.targetCents > 0 ? Math.floor((savedCents * 100) / goal.targetCents) : 0;
  const benMissing = profile.profile?.beneficiaryStatus === "missing";
  const unfunded = profile.profile?.accountFundingStatus === "unfunded";
  const firstName = profile.displayName.split(" ")[0] ?? profile.displayName;
  const addBeneficiary = { label: "Add a beneficiary", prompt: "How do I update my beneficiary designation?" };

  if (section === "portfolio") {
    return {
      id: "wealth-portfolio",
      label: `Your portfolio · ${totalLabel}`,
      viewType: "wealth_portfolio",
      summary: `You hold ${equityLabel} in stocks, ${fixedLabel} in bonds and ${cashLabel} in cash.`,
      metrics: [
        { label: "Stocks", value: equityLabel },
        { label: "Bonds", value: fixedLabel },
        { label: "Cash", value: cashLabel },
      ],
      suggestedActions: [
        { label: "What stocks do I own?", prompt: "whats in my equity book right now?" },
        { label: "View holdings as a bubble chart", prompt: "Show my stock holdings as a bubble chart" },
        { label: "How do wash-sale rules work?", prompt: "What is our policy on tax-loss harvesting and wash-sale rules?" },
      ],
    };
  }
  if (section === "savings") {
    const targetLabel = goal ? formatPortfolioAmount(goal.targetCents) : "$100,000";
    const savedLabel = formatPortfolioAmount(savedCents);
    return {
      id: "wealth-savings",
      label: `Home down payment · ${goalPct}% of your goal`,
      viewType: "wealth_savings_goal",
      summary: `You've saved ${savedLabel} toward your ${targetLabel} down payment. Keep going, ${firstName}.`,
      metrics: [
        { label: "Saved", value: savedLabel },
        { label: "Goal", value: targetLabel },
        { label: "Progress", value: `${goalPct}%` },
      ],
      suggestedActions: [
        { label: "Plan to buy a home in 2 years", prompt: "I want to buy a house in two years. Show me how close I am and help me explore a savings plan." },
        { label: "How am I tracking?", prompt: homeGoalPrompt },
        { label: "Send money to escrow", prompt: "I want to initiate a wire transfer" },
      ],
    };
  }
  if (section === "account") {
    const todo = (benMissing ? 1 : 0) + (unfunded ? 1 : 0);
    return {
      id: "wealth-account",
      label: todo ? `Your account · ${todo} thing${todo > 1 ? "s" : ""} to finish` : "Your account · all set",
      viewType: "wealth_account_status",
      summary: [
        unfunded ? "Your account is open and waiting for its first deposit." : "Your account is funded.",
        benMissing ? "You haven't named a beneficiary yet; it only takes a minute." : "Your beneficiaries are on file.",
      ].join(" "),
      metrics: [
        { label: "Deposit", value: unfunded ? "Waiting" : "Received" },
        { label: "Beneficiary", value: benMissing ? "Not added" : "On file" },
        { label: "Cash", value: cashLabel },
      ],
      suggestedActions: [
        ...(benMissing ? [addBeneficiary] : []),
        { label: "Update my mailing address", prompt: "I need to update my mailing address." },
        { label: "Wire limits & security", prompt: "What are the wire transfer approval limits and security rules?" },
      ],
    };
  }
  if (section === "next-step") {
    return {
      id: "wealth-next-step",
      label: `Your next step, ${firstName}`,
      viewType: "wealth_next_step",
      summary: unfunded
        ? "Make your first deposit to start investing. Here are a few things you can do now."
        : `You have ${cashLabel} in cash that isn't invested yet. Here are a few ideas.`,
      metrics: [
        { label: "Total", value: totalLabel },
        { label: "Cash", value: cashLabel },
      ],
      suggestedActions: [
        { label: "Review my portfolio", prompt: portfolioPrompt },
        { label: "What do my balances mean?", prompt: "Explain the balance labels." },
        { label: "Learn about retirement", prompt: "I'd like to learn about retirement." },
      ],
    };
  }
  return {
    id: "wealth-summary",
    label: `Your wealth · ${totalLabel}`,
    viewType: "wealth_summary",
    summary: `You have ${cashLabel} in cash and ${equityLabel} invested in stocks.${benMissing ? " One thing to finish: you haven't named a beneficiary yet." : ""}`,
    metrics: [
      { label: "Total", value: totalLabel },
      { label: "Cash", value: cashLabel },
      { label: "Stocks", value: equityLabel },
    ],
    suggestedActions: [
      { label: "Review my portfolio", prompt: portfolioPrompt },
      ...(benMissing ? [addBeneficiary] : []),
      { label: "What stocks do I own?", prompt: "whats in my equity book right now?" },
      { label: "Send a wire transfer", prompt: "I want to initiate a wire transfer" },
    ].slice(0, 4),
  };
}
