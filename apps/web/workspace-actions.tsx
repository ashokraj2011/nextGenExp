import { useEffect, useId, useRef, useState } from "react";
import { ArrowUpRight, CircleCheck, ListPlus, ShieldCheck, Wallet } from "lucide-react";
import type { TurnView } from "../../packages/contracts/api";
import type { WorkspaceActionState, WorkspaceFundingProgress, WorkspacePendingAction, WorkspaceTodoCommand } from "../../packages/contracts/workspace";
import { api, RequestError } from "./api";

export function latestFundingExperienceId(turns?: TurnView[]) {
  return turns?.findLast(({ experience }) => experience?.blocks.some(({ component }) =>
    component === "PznFundingOptions" || component === "PznFundingPreview"))?.experience?.experienceId;
}

export function usePendingActions(personaId?: string, fundingExperienceId?: string) {
  const [result, setResult] = useState<{ personaId: string; items?: WorkspacePendingAction[]; failed?: true }>();
  const [actionState, setActionState] = useState<{ personaId: string; value?: WorkspaceActionState; failed?: true }>();
  const [attempt, setAttempt] = useState(0);
  const [editingTodo, setEditingTodo] = useState(false);
  const [todoFeedback, setTodoFeedback] = useState<{ personaId: string; text: string; error?: true }>();
  const stateRead = useRef(0);
  const current = result?.personaId === personaId ? result : undefined;
  const state = actionState?.personaId === personaId ? actionState : undefined;
  const funding = state?.value?.funding;
  const completed = funding?.status === "completed";
  const refresh = () => setAttempt((value) => value + 1);

  useEffect(() => {
    if (!personaId) return;
    let active = true;
    void api.pendingActions(personaId).then(
      (items) => { if (active) setResult({ personaId, items }); },
      () => { if (active) setResult({ personaId, failed: true }); },
    );
    return () => { active = false; };
  }, [personaId, attempt]);

  useEffect(() => {
    if (!personaId) return;
    let active = true;
    let trackFunding = false;
    const read = () => {
      const version = ++stateRead.current;
      const currentRead = () => active && version === stateRead.current;
      void api.workspaceActionState(personaId).then((value) => {
        if (!currentRead()) return;
        trackFunding = value.funding?.status === "in_progress";
        setActionState({ personaId, value });
      }, () => {
        if (currentRead()) setActionState((previous) => ({ personaId, value: previous?.personaId === personaId ? previous.value : undefined, failed: true }));
      });
    };
    read();
    const timer = window.setInterval(() => {
      if (trackFunding && document.visibilityState === "visible") read();
    }, 5000);
    window.addEventListener("focus", read);
    return () => { active = false; clearInterval(timer); window.removeEventListener("focus", read); };
  }, [personaId, attempt, fundingExperienceId]);

  useEffect(() => {
    if (completed) setAttempt((value) => value + 1);
  }, [completed, personaId]);

  const changeTodo = async (command: WorkspaceTodoCommand) => {
    if (!personaId || editingTodo) return;
    setEditingTodo(true);
    setTodoFeedback(undefined);
    try {
      const todos = await api.changeWorkspaceTodo(personaId, command);
      stateRead.current += 1;
      setActionState((stored) => stored?.personaId === personaId && stored.value
        ? { ...stored, value: { ...stored.value, todos } } : stored);
      setTodoFeedback({ personaId, text: command.operation === "save" ? "Added to your to-do list." : "Removed from your to-do list." });
    } catch (error) {
      setTodoFeedback({ personaId, error: true, text: error instanceof RequestError ? error.message : "Couldn’t update your to-do list." });
    } finally {
      refresh();
      setEditingTodo(false);
    }
  };

  return {
    items: current?.items, failed: current?.failed, stateFailed: state?.failed, funding,
    todos: state?.value?.todos, editingTodo, todoFeedback: todoFeedback?.personaId === personaId ? todoFeedback : undefined,
    changeTodo, refresh,
  };
}

export type PendingActions = ReturnType<typeof usePendingActions>;

export function DepositConfirmation({ confirmedAt }: { confirmedAt?: number }) {
  return <p className="deposit-confirmation" role="status">
    <CircleCheck size={17} aria-hidden="true" />
    <strong>{confirmedAt === undefined ? "Account funded" : "First deposit confirmed"}</strong>
    {confirmedAt !== undefined && <time dateTime={new Date(confirmedAt).toISOString()}>
      {new Date(confirmedAt).toLocaleDateString(undefined, { dateStyle: "medium" })}
    </time>}
  </p>;
}

function PendingActionItem({ item, funding, saved, canSave, availability, disabled, modelUnavailable, editingTodo, onReviewGuide, onPreviewFunding, onChangeTodo }: {
  item: WorkspacePendingAction; funding?: WorkspaceFundingProgress | null;
  saved?: boolean; canSave?: boolean; availability?: string; disabled: boolean; modelUnavailable: boolean; editingTodo: boolean;
  onReviewGuide: (message: string) => void; onPreviewFunding: () => void; onChangeTodo: (command: WorkspaceTodoCommand) => void;
}) {
  const { action } = item;
  const Icon = action.kind === "guide" ? ShieldCheck : Wallet;
  const progress = action.kind === "funding" ? funding : undefined;
  return <li>
    <span className="pending-action-icon"><Icon size={17} aria-hidden="true" /></span>
    <div>
      <h4>{item.title}</h4>
      {progress?.status === "completed" ? <DepositConfirmation confirmedAt={progress.confirmedAt} />
        : <p>{availability ?? (progress?.status === "in_progress" ? "Pick up where you left off in chat." : item.body)}</p>}
    </div>
    <div className="pending-action-controls">
      {!availability && progress?.status !== "completed" && <button className="overview-action" type="button"
        disabled={disabled || (modelUnavailable && progress?.status !== "in_progress")}
        onClick={() => action.kind === "guide" ? onReviewGuide(action.message) : onPreviewFunding()}>
        {progress?.status === "in_progress" ? "Continue funding" : action.label} <ArrowUpRight size={15} aria-hidden="true" />
      </button>}
      {(saved || canSave) && <button className="todo-button" type="button" disabled={editingTodo}
        aria-label={(saved ? "Remove " : "Add ") + item.title + (saved ? " from to-do list" : " to to-do list")}
        onClick={() => onChangeTodo({ operation: saved ? "remove" : "save", contentId: item.contentId })}>
        {!saved && <ListPlus size={15} aria-hidden="true" />}{saved ? "Remove" : "Add to to-do list"}
      </button>}
    </div>
  </li>;
}

export function PendingActionsCard({ pendingActions, firstDepositConfirmedAt, disabled, modelUnavailable, onReviewGuide, onPreviewFunding }: {
  firstDepositConfirmedAt?: number;
  pendingActions: PendingActions; disabled: boolean; modelUnavailable: boolean; onReviewGuide: (message: string) => void; onPreviewFunding: () => void;
}) {
  const title = useId();
  const todoTitle = useId();
  const pendingHeading = useRef<HTMLHeadingElement>(null);
  const todoHeading = useRef<HTMLHeadingElement>(null);
  const focusAfterEdit = useRef<WorkspaceTodoCommand["operation"]>(undefined);
  const { items, failed, stateFailed, todos, editingTodo, todoFeedback, changeTodo, refresh } = pendingActions;
  const funding = pendingActions.funding?.status === "completed" || firstDepositConfirmedAt === undefined
    ? pendingActions.funding : { status: "completed" as const, confirmedAt: firstDepositConfirmedAt };
  const completed = funding?.status === "completed";
  const confirmedAt = funding?.status === "completed" ? funding.confirmedAt : firstDepositConfirmedAt;
  const eligible = (items ?? []).filter(({ action }) => !completed || action.kind !== "funding");
  const recommendations = eligible.filter(({ contentId }) => !todos?.some((item) => item.contentId === contentId));
  const [first, ...remaining] = recommendations;
  const savedFunding = todos?.some(({ action }) => action.kind === "funding");
  const onChangeTodo = (command: WorkspaceTodoCommand) => {
    focusAfterEdit.current = command.operation;
    void changeTodo(command);
  };
  useEffect(() => {
    const operation = focusAfterEdit.current;
    if (!operation || editingTodo || !todoFeedback) return;
    focusAfterEdit.current = undefined;
    if (!todoFeedback.error) (operation === "save" ? todoHeading : pendingHeading).current?.focus();
  }, [editingTodo, todoFeedback]);
  const itemProps = { disabled, modelUnavailable, onReviewGuide, onPreviewFunding, funding, editingTodo, onChangeTodo };

  return <section className="content-card pending-actions" aria-labelledby={title}>
    <h3 id={title} ref={pendingHeading} tabIndex={-1}>Pending actions</h3>
    {first && <ul><PendingActionItem item={first} canSave={Boolean(todos)} {...itemProps} /></ul>}
    {remaining.length > 0 && <details className="inline-details remaining-pending-actions">
      <summary>Other pending actions ({remaining.length})</summary>
      <ul>{remaining.map((item) => <PendingActionItem key={item.contentId} item={item} canSave={Boolean(todos)} {...itemProps} />)}</ul>
    </details>}
    {items && !eligible.length && <p>No pending actions.</p>}
    {!items && (failed ? <div className="next-step-error">
      <p role="status">Couldn’t load pending actions.</p>
      <button className="secondary-button" type="button" onClick={refresh}>Try again</button>
    </div> : <p role="status">Checking pending actions…</p>)}
    {completed && !savedFunding && <div className="pending-completion"><DepositConfirmation confirmedAt={confirmedAt} /></div>}
    {Boolean(todos?.length) && <section className="workspace-todos" aria-labelledby={todoTitle}>
      <h4 id={todoTitle} ref={todoHeading} tabIndex={-1}>To-do list</h4>
      <ul>{todos?.map((saved) => {
        const item = eligible.find(({ contentId }) => contentId === saved.contentId);
        const availability = item ? undefined : items ? "This action is no longer available." : failed ? "Availability couldn’t be checked." : "Checking availability…";
        return <PendingActionItem key={saved.contentId} item={item ?? saved} saved availability={availability} {...itemProps} />;
      })}</ul>
    </section>}
    <div aria-live="polite" className={todoFeedback?.error ? "todo-notice" : "sr-only"}>{todoFeedback?.text}</div>
    {stateFailed && <div className="next-step-error">
      <p role="status">Couldn’t refresh action status.</p>
      <button className="secondary-button" type="button" onClick={refresh}>Try again</button>
    </div>}
  </section>;
}
