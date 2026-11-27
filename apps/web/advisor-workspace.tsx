import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowUp, CheckCircle2, ExternalLink, Loader2, Radio, Send, Sparkles } from "lucide-react";
import { progressLabels, type Bootstrap, type ConversationView, type DemoPersona, type TurnView } from "../../packages/contracts/api";
import type { HandoffTicket } from "../../packages/contracts/handoff";
import type { DisplayExperience } from "../../packages/contracts/surface";
import { api, toolSetupErrorMessage } from "./api";
import { ProfileAvatar } from "./demo-profiles";
import { LabMark } from "./lab-mark";
import { ExperienceCanvasView, ExperienceControls, installA2uiStyles } from "./surface";
import { ThemeToggle } from "./theme";
import "./advisor-workspace.css";

installA2uiStyles();

const ADVISOR_NAME = "Priya Sharma, CFP®";

const QUICK_PROMPTS = [
  { label: "Portfolio summary", prompt: "Let me know my portfolio summary." },
  { label: "2-year home plan", prompt: "I want to buy a house in two years. Show me how close I am and help me explore a savings plan." },
  { label: "Compare balances", prompt: "Compare available and current balance." },
  { label: "Retirement accounts", prompt: "Show my retirement accounts." },
];

export function AdvisorWorkspace() {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [clientId, setClientId] = useState<string>("demo-learner");
  const [conversation, setConversation] = useState<ConversationView | null>(null);
  const [ticket, setTicket] = useState<HandoffTicket | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [noteInput, setNoteInput] = useState("");
  const [sendingNote, setSendingNote] = useState(false);
  const [error, setError] = useState("");
  const sharedTurnIds = useRef(new Set<string>());

  useEffect(() => {
    void api.bootstrap("wealth").then((data) => {
      setBoot(data);
      const initial = data.defaultPersonaId || data.personas[0]?.personaId || "demo-learner";
      setClientId(initial);
    }).catch((e) => setError(toolSetupErrorMessage(e)));
  }, []);

  const client: DemoPersona | undefined = useMemo(
    () => boot?.personas.find((p) => p.personaId === clientId) ?? boot?.personas[0],
    [boot, clientId],
  );

  // Ensure one live shared room exists for this client so both Advisor and Client see the exact same card.
  useEffect(() => {
    if (!client) return;
    let alive = true;
    setError("");
    void (async () => {
      try {
        const active = await api.activeHandoff(client.personaId);
        let liveTicket = active.ticket;
        if (!liveTicket) {
          const created = await api.createHandoff({
            conversationId: `adv_room_${client.personaId}`,
            personaId: client.personaId,
            domain: "wealth",
            reason: `Live session with ${ADVISOR_NAME}`,
            assignedAgent: ADVISOR_NAME,
          });
          liveTicket = created.ticket;
        }
        if (alive) setTicket(liveTicket);
      } catch (e) {
        if (alive) setError(toolSetupErrorMessage(e));
      }
    })();
    return () => { alive = false; };
  }, [client?.personaId]);

  // Real-time SSE sync on the shared room.
  useEffect(() => {
    if (!ticket?.handoffId) return;
    let alive = true;
    const stream = new EventSource(`/api/handoffs/${encodeURIComponent(ticket.handoffId)}/stream`);
    stream.addEventListener("handoff.update", (evt) => {
      if (!alive) return;
      try { setTicket(JSON.parse((evt as MessageEvent).data) as HandoffTicket); } catch { /* ignore */ }
    });
    return () => { alive = false; stream.close(); };
  }, [ticket?.handoffId]);

  // Reset chat when switching client.
  useEffect(() => {
    setConversation(null);
    sharedTurnIds.current.clear();
  }, [client?.personaId]);

  const shareTurnCard = useCallback(async (turn: TurnView) => {
    if (!ticket || !turn.experience) return;
    try {
      const res = await api.shareHandoffCard(ticket.handoffId, {
        turnId: turn.id,
        prompt: turn.message,
        sharedBy: "advisor",
        sharedByName: ADVISOR_NAME,
        experience: turn.experience as unknown as Record<string, unknown>,
      });
      setTicket(res.ticket);
    } catch (e) {
      setError(toolSetupErrorMessage(e));
    }
  }, [ticket]);

  // Auto-sync the latest completed A2UI card to the shared right pane & client's /chat tab.
  useEffect(() => {
    if (!conversation || !ticket) return;
    const latest = conversation.turns.at(-1);
    if (!latest || latest.status !== "completed" || !latest.experience || sharedTurnIds.current.has(latest.id)) return;
    sharedTurnIds.current.add(latest.id);
    void shareTurnCard(latest);
  }, [conversation, ticket, shareTurnCard]);

  // Live SSE updates while AI Agent is generating the card.
  const workingTurnId = useMemo(
    () => conversation?.turns.find((t) => t.status === "working")?.id,
    [conversation],
  );
  useEffect(() => {
    if (!workingTurnId) return;
    let alive = true;
    const stream = new EventSource(`/api/turns/${encodeURIComponent(workingTurnId)}/events`);
    const refresh = () => {
      void api.turn(workingTurnId).then((updated) => {
        if (!alive) return;
        setConversation((prev) => prev ? {
          ...prev,
          turns: prev.turns.map((t) => (t.id === updated.id ? updated : t)),
        } : prev);
      }).catch(() => undefined);
    };
    for (const evt of ["turn.status", "experience.ready", "turn.failed", "turn.cancelled"]) {
      stream.addEventListener(evt, refresh);
    }
    const poll = setInterval(refresh, 1500);
    return () => { alive = false; stream.close(); clearInterval(poll); };
  }, [workingTurnId]);

  const askAgent = useCallback(async (message: string) => {
    const text = message.trim();
    if (!text || !client || !boot || sending || workingTurnId) return;
    setSending(true);
    setError("");
    try {
      let conv = conversation;
      if (!conv) {
        conv = await api.newConversation(client.personaId, boot.defaultScenarioId, "wealth");
        setConversation(conv);
      }
      const accepted = await api.send(conv.id, text, crypto.randomUUID());
      setConversation((prev) => {
        const base = prev ?? { ...accepted.conversation, turns: [] };
        return { ...base, turns: [...base.turns.filter((t) => t.id !== accepted.turn.id), accepted.turn] };
      });
      setDraft("");
    } catch (e) {
      setError(toolSetupErrorMessage(e));
    } finally {
      setSending(false);
    }
  }, [boot, client, conversation, sending, workingTurnId]);

  const sendAdvisorNote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ticket || !noteInput.trim() || sendingNote) return;
    setSendingNote(true);
    try {
      const res = await api.handoffCustomerReply(ticket.handoffId, noteInput.trim(), "agent", ADVISOR_NAME);
      setTicket(res.ticket);
      setNoteInput("");
    } catch (err) {
      setError(toolSetupErrorMessage(err));
    } finally {
      setSendingNote(false);
    }
  };

  const sharedExperience = ticket?.coBrowse?.sharedCard?.experience as DisplayExperience | undefined;
  const visibleNotes = (ticket?.notes ?? []).filter((n) => n.role !== "system").slice(-4);

  const controlsValue = useMemo(() => ({
    activeExperienceId: sharedExperience?.experienceId,
    allowRuleCreation: false,
    askPrompt: (prompt: string) => void askAgent(prompt),
    followUp: (_id: string, envelope: { action?: { context?: { actionId?: string } } }) => {
      const actionId = envelope.action?.context?.actionId;
      if (actionId) void askAgent(`Follow up on ${actionId}`);
    },
    rendered: () => undefined,
  }), [askAgent, sharedExperience?.experienceId]);

  return (
    <div className="advisor-simple-shell">
      <header className="advisor-simple-bar">
        <div className="advisor-simple-brand">
          <a href="/chat" className="icon-button" aria-label="Back to chat" title="Back to chat">
            <ArrowLeft size={17} aria-hidden="true" />
          </a>
          <LabMark small />
          <strong>Advisor Chat</strong>
          <span className="advisor-persona-tag">{ADVISOR_NAME}</span>
        </div>

        <div className="advisor-simple-controls">
          <label className="advisor-client-picker">
            <span>Client</span>
            <select aria-label="Select client" value={clientId} onChange={(e) => setClientId(e.target.value)}>
              {(boot?.personas ?? []).map((p) => (
                <option key={p.personaId} value={p.personaId}>{p.displayName}</option>
              ))}
            </select>
          </label>

          <a
            className="advisor-open-client"
            href={`/chat?personaId=${encodeURIComponent(clientId)}`}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink size={14} aria-hidden="true" />
            <span>Open Client View</span>
          </a>
          <ThemeToggle compact />
        </div>
      </header>

      {error && <p className="rich-error" role="alert" style={{ margin: "10px 20px 0" }}>{error}</p>}

      <ExperienceControls.Provider value={controlsValue}>
        <main className="advisor-simple-grid">
          {/* LEFT: Clean Advisor <-> AI Agent Chat */}
          <section className="advisor-chat-col" aria-label="Advisor chat with AI Agent">
            <div className="advisor-col-head">
              <ProfileAvatar name={ADVISOR_NAME} />
              <div>
                <strong>Chat with AI Agent</strong>
                <small>Ask for {client?.displayName ?? "client"} — the card syncs live on the right</small>
                {client?.profile?.notes && (
                  <div style={{ marginTop: "4px", fontSize: "0.78rem", color: "var(--teal-dark, #1d4b3e)", fontWeight: 500 }}>
                    Customer 360 Note: {client.profile.notes}
                  </div>
                )}
              </div>
            </div>

            <div className="advisor-messages">
              {(!conversation || conversation.turns.length === 0) && (
                <div className="advisor-welcome">
                  <Sparkles size={20} aria-hidden="true" />
                  <h3>Ask the AI Agent anything for {client?.displayName ?? "your client"}</h3>
                  <p>Both you and {client?.displayName ?? "the client"} see the exact same card live.</p>
                  <div className="advisor-chips">
                    {QUICK_PROMPTS.map((q) => (
                      <button
                        key={q.label}
                        type="button"
                        className="advisor-chip"
                        disabled={sending || Boolean(workingTurnId)}
                        onClick={() => void askAgent(q.prompt)}
                      >
                        {q.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {(conversation?.turns ?? []).map((turn) => {
                const isSynced = ticket?.coBrowse?.sharedCard?.turnId === turn.id;
                return (
                  <div key={turn.id} className="advisor-msg-pair">
                    <div className="advisor-bubble-out">{turn.message}</div>
                    <div className="advisor-bubble-in">
                      {turn.status === "working" ? (
                        <span className="advisor-progress">
                          <Loader2 size={14} className="reasoning-spinner" aria-hidden="true" />
                          {progressLabels[turn.progress] ?? "Working"}…
                        </span>
                      ) : turn.experience ? (
                        <div className="advisor-turn-summary">
                          {turn.emotionalState && (turn.emotionalState.suppressPromotions || turn.emotionalState.lifeEvent !== "none") && (
                            <div style={{ marginBottom: "6px", fontSize: "0.76rem", fontWeight: 600, color: "#92400e", background: "#fef3c7", border: "1px solid #fcd34d", borderRadius: "6px", padding: "3px 8px", display: "inline-block" }}>
                              {turn.emotionalState.source === "customer360_notes" ? "Customer 360 Note" : "Empathy Layer"} · {turn.emotionalState.lifeEvent.replace(/_/g, " ")}
                              {turn.emotionalState.suppressPromotions ? " · Promotional offers paused" : ""}
                            </div>
                          )}
                          <p>{turn.experience.intro}</p>
                          <div className="advisor-turn-foot">
                            {isSynced ? (
                              <span className="advisor-synced-tag"><CheckCircle2 size={12} /> Shown to both</span>
                            ) : (
                              <button type="button" className="advisor-chip" onClick={() => void shareTurnCard(turn)}>
                                Show on shared card
                              </button>
                            )}
                          </div>
                        </div>
                      ) : (
                        <span className="advisor-failed">Could not complete ({turn.failureCode ?? turn.status}). Try again.</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="advisor-bottom-dock">
              {conversation && conversation.turns.length > 0 && (
                <div className="advisor-chips is-compact">
                  {QUICK_PROMPTS.slice(0, 3).map((q) => (
                    <button
                      key={q.label}
                      type="button"
                      className="advisor-chip"
                      disabled={sending || Boolean(workingTurnId)}
                      onClick={() => void askAgent(q.prompt)}
                    >
                      {q.label}
                    </button>
                  ))}
                </div>
              )}
              <form className="advisor-input-bar" onSubmit={(e) => { e.preventDefault(); void askAgent(draft); }}>
                <input
                  aria-label="Message AI Agent"
                  placeholder={`Ask AI Agent for ${client?.displayName ?? "client"}…`}
                  value={draft}
                  disabled={sending || Boolean(workingTurnId)}
                  onChange={(e) => setDraft(e.target.value)}
                />
                <button type="submit" className="advisor-send-btn" disabled={sending || Boolean(workingTurnId) || !draft.trim()}>
                  <ArrowUp size={16} aria-hidden="true" />
                </button>
              </form>
            </div>
          </section>

          {/* RIGHT: Single Shared Live Card Seen by Both Advisor & Client */}
          <section className="advisor-stage-col" aria-label="Shared live card seen by both advisor and client">
            <div className="advisor-stage-head">
              <div className="advisor-presence">
                <span className="advisor-live-dot" aria-hidden="true" />
                <Radio size={13} aria-hidden="true" />
                <strong>Same card seen by both</strong>
              </div>
              <div className="advisor-avatars">
                <span><ProfileAvatar name={ADVISOR_NAME} /> {ADVISOR_NAME.split(",")[0]}</span>
                <span>&amp;</span>
                <span><ProfileAvatar name={client?.displayName ?? "Client"} /> {client?.displayName ?? "Client"}</span>
              </div>
            </div>

            <div className="advisor-stage-canvas">
              {sharedExperience ? (
                <ExperienceCanvasView data={sharedExperience} />
              ) : (
                <div className="advisor-stage-empty">
                  <Sparkles size={24} aria-hidden="true" />
                  <p>Ask the AI Agent on the left — the card will appear here and in <strong>{client?.displayName ?? "the client"}’s</strong> chat window at the exact same time.</p>
                </div>
              )}
            </div>

            {ticket && (
              <div className="advisor-note-bar">
                {visibleNotes.length > 0 && (
                  <div className="advisor-note-list">
                    {visibleNotes.map((n) => (
                      <div key={n.id} className={"advisor-note-line is-" + n.role}>
                        <strong>{n.author}:</strong> {n.text}
                      </div>
                    ))}
                  </div>
                )}
                <form className="advisor-note-form" onSubmit={(e) => void sendAdvisorNote(e)}>
                  <input
                    aria-label="Send direct note to client"
                    placeholder={`Send a note to ${client?.displayName ?? "client"} alongside this card…`}
                    value={noteInput}
                    onChange={(e) => setNoteInput(e.target.value)}
                  />
                  <button type="submit" className="advisor-chip" disabled={sendingNote || !noteInput.trim()}>
                    <Send size={13} aria-hidden="true" />Send
                  </button>
                </form>
              </div>
            )}
          </section>
        </main>
      </ExperienceControls.Provider>
    </div>
  );
}
