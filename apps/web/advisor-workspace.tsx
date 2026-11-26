import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft, ArrowUp, ExternalLink, Headphones, Loader2, Radio, Send, Share2, Sparkles, Users,
} from "lucide-react";
import type { Bootstrap, ConversationView, DemoPersona, TurnView } from "../../packages/contracts/api";
import type { HandoffTicket } from "../../packages/contracts/handoff";
import { formatPortfolioAmount } from "../../packages/contracts/portfolio";
import type { DisplayExperience } from "../../packages/contracts/surface";
import { api, toolSetupErrorMessage } from "./api";
import { ProfileAvatar } from "./demo-profiles";
import { LabMark } from "./lab-mark";
import { MultiplayerCoBrowseCard } from "./nextgen-chat-features";
import { ExperienceCanvasView, ExperienceControls, installA2uiStyles } from "./surface";
import { ThemeToggle } from "./theme";
import "./advisor-workspace.css";

installA2uiStyles();

type AdvisorPersona = {
  id: string;
  name: string;
  role: string;
  specialty: string;
};

const ADVISOR_PERSONAS: AdvisorPersona[] = [
  { id: "adv-priya", name: "Priya Sharma, CFP®", role: "Senior Wealth Advisor", specialty: "Goals, Tax-Smart Rebalancing & Retirement" },
  { id: "adv-david", name: "David Vance, CFA", role: "Portfolio Strategist", specialty: "Asset Allocation & Equity Liquidity" },
];

const ADVISOR_PROMPTS = [
  { label: "Client portfolio mix", prompt: "Let me know my portfolio summary." },
  { label: "2-year home savings plan", prompt: "I want to buy a house in two years. Show me how close I am and help me explore a savings plan." },
  { label: "Compare balance terms", prompt: "Compare available and current balance." },
  { label: "Retirement & beneficiary", prompt: "Show my retirement accounts." },
  { label: "Home-buying progress", prompt: "Show my home-buying goal and savings progress." },
];

export function AdvisorWorkspace() {
  const [advisor, setAdvisor] = useState<AdvisorPersona>(ADVISOR_PERSONAS[0]!);
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [clientId, setClientId] = useState<string>("demo-learner");
  const [conversation, setConversation] = useState<ConversationView | null>(null);
  const [ticket, setTicket] = useState<HandoffTicket | null>(null);
  const [autoShare, setAutoShare] = useState(true);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [mirrorRole, setMirrorRole] = useState<"customer" | "advisor">("customer");
  const [noteInput, setNoteInput] = useState("");
  const [sendingNote, setSendingNote] = useState(false);
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

  // Ensure a live shared room (HandoffTicket) exists for this Advisor + Client pair, and open a real SSE stream!
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
            reason: `Live Advisor Co-Pilot session started by ${advisor.name}`,
            assignedAgent: advisor.name,
          });
          liveTicket = created.ticket;
        }
        if (alive) setTicket(liveTicket);
      } catch (e) {
        if (alive) setError(toolSetupErrorMessage(e));
      }
    })();
    return () => { alive = false; };
  }, [client?.personaId, advisor.name]);

  // Real-time SSE subscription on the shared room (syncs shared A2UI cards, sliders, proposals, & live notes).
  useEffect(() => {
    if (!ticket?.handoffId) return;
    let alive = true;
    const stream = new EventSource(`/api/handoffs/${encodeURIComponent(ticket.handoffId)}/stream`);
    stream.addEventListener("handoff.update", (evt) => {
      if (!alive) return;
      try {
        setTicket(JSON.parse((evt as MessageEvent).data) as HandoffTicket);
      } catch { /* ignore */ }
    });
    return () => { alive = false; stream.close(); };
  }, [ticket?.handoffId]);

  // Reset AI agent conversation when switching client persona.
  useEffect(() => {
    setConversation(null);
    sharedTurnIds.current.clear();
  }, [client?.personaId]);

  const pushCardToBoth = useCallback(async (turn: TurnView) => {
    if (!ticket || !turn.experience) return;
    try {
      const res = await api.shareHandoffCard(ticket.handoffId, {
        turnId: turn.id,
        prompt: turn.message,
        sharedBy: "advisor",
        sharedByName: advisor.name,
        experience: turn.experience as unknown as Record<string, unknown>,
      });
      setTicket(res.ticket);
    } catch (e) {
      setError(toolSetupErrorMessage(e));
    }
  }, [ticket, advisor.name]);

  // Auto-push newly completed A2UI cards to the shared room so Advisor & Client see the exact same card instantly!
  useEffect(() => {
    if (!autoShare || !conversation || !ticket) return;
    const latest = conversation.turns.at(-1);
    if (!latest || latest.status !== "completed" || !latest.experience || sharedTurnIds.current.has(latest.id)) return;
    sharedTurnIds.current.add(latest.id);
    void pushCardToBoth(latest);
  }, [autoShare, conversation, ticket, pushCardToBoth]);

  // Subscribe to SSE turn events while the AI Agent is working.
  const activeWorkingTurnId = useMemo(
    () => conversation?.turns.find((t) => t.status === "working")?.id,
    [conversation],
  );
  useEffect(() => {
    if (!activeWorkingTurnId) return;
    let alive = true;
    const stream = new EventSource(`/api/turns/${encodeURIComponent(activeWorkingTurnId)}/events`);
    const refresh = () => {
      void api.turn(activeWorkingTurnId).then((updated) => {
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
    const pollFallback = setInterval(refresh, 2000);
    return () => { alive = false; stream.close(); clearInterval(pollFallback); };
  }, [activeWorkingTurnId]);

  const askAgent = useCallback(async (message: string) => {
    const text = message.trim();
    if (!text || !client || !boot || sending) return;
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
  }, [boot, client, conversation, sending]);

  const sendLiveNote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ticket || !noteInput.trim() || sendingNote) return;
    setSendingNote(true);
    try {
      const res = await api.handoffCustomerReply(
        ticket.handoffId,
        noteInput.trim(),
        mirrorRole === "advisor" ? "agent" : "customer",
        mirrorRole === "advisor" ? advisor.name : (client?.displayName ?? ticket.customerName),
      );
      setTicket(res.ticket);
      setNoteInput("");
    } catch (err) {
      setError(toolSetupErrorMessage(err));
    } finally {
      setSendingNote(false);
    }
  };

  const sharedExperience = ticket?.coBrowse?.sharedCard?.experience as DisplayExperience | undefined;
  const startingBalanceUsd = useMemo(() => {
    const p = client?.overview?.portfolio;
    if (!p) return 45_000;
    return Math.round((p.cashCents + p.equityCents + p.fixedIncomeCents) / 100);
  }, [client]);

  const sharedControlsValue = useMemo(() => ({
    activeExperienceId: sharedExperience?.experienceId,
    allowRuleCreation: false,
    accountPortalAvailable: false,
    askPrompt: (prompt: string) => void askAgent(prompt),
    followUp: (_id: string, envelope: { action?: { context?: { actionId?: string } } }) => {
      const label = envelope.action?.context?.actionId ?? "Follow up";
      void askAgent(`Continue with ${label}`);
    },
    rendered: () => undefined,
  }), [askAgent, sharedExperience?.experienceId]);

  return (
    <div className="advisor-shell">
      <header className="advisor-topbar">
        <div className="advisor-brand">
          <a href="/chat" className="icon-button" title="Back to customer chat" aria-label="Back to customer chat">
            <ArrowLeft size={17} aria-hidden="true" />
          </a>
          <LabMark small />
          <div>
            <strong>CEP Advisor Co-Pilot</strong>
            <small>Advisor ↔ AI Agent ↔ Client Shared Card Simulator</small>
          </div>
        </div>

        <div className="advisor-selectors">
          <label className="advisor-select-pill">
            <span>Advisor Persona</span>
            <select
              aria-label="Select Advisor Persona"
              value={advisor.id}
              onChange={(e) => setAdvisor(ADVISOR_PERSONAS.find((a) => a.id === e.target.value) ?? ADVISOR_PERSONAS[0]!)}
            >
              {ADVISOR_PERSONAS.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.role}</option>)}
            </select>
          </label>

          <label className="advisor-select-pill">
            <span>Co-Advising Client</span>
            <select
              aria-label="Select Client Persona"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
            >
              {(boot?.personas ?? []).map((p) => (
                <option key={p.personaId} value={p.personaId}>{p.displayName}</option>
              ))}
            </select>
          </label>

          <label className="advisor-autosync-toggle">
            <input type="checkbox" checked={autoShare} onChange={(e) => setAutoShare(e.target.checked)} />
            <span>Auto-sync cards to client</span>
          </label>
        </div>

        <div className="advisor-topbar-right">
          <a
            className="topbar-rich-btn"
            href={`/chat?personaId=${encodeURIComponent(clientId)}`}
            target="_blank"
            rel="noreferrer"
            title="Open the real customer chat in a second browser tab to watch cards sync across windows"
          >
            <ExternalLink size={13} aria-hidden="true" />
            <span>Open Client Tab</span>
          </a>
          <ThemeToggle compact />
        </div>
      </header>

      {client?.overview?.portfolio && (
        <div className="advisor-client-strip">
          <div className="advisor-client-id">
            <ProfileAvatar name={client.displayName} />
            <div>
              <strong>{client.displayName}</strong>
              <small>Account: {client.profile?.accountFundingStatus ?? "funded"} · Beneficiary: {client.profile?.beneficiaryStatus ?? "on_file"}</small>
            </div>
          </div>
          <div className="advisor-client-metrics">
            <span>Cash <strong>{formatPortfolioAmount(client.overview.portfolio.cashCents)}</strong></span>
            <span>Equities <strong>{formatPortfolioAmount(client.overview.portfolio.equityCents)}</strong></span>
            <span>Fixed Income <strong>{formatPortfolioAmount(client.overview.portfolio.fixedIncomeCents)}</strong></span>
            {ticket && <span className="advisor-room-badge"><Radio size={11} /> Room <code>{ticket.handoffId}</code></span>}
          </div>
        </div>
      )}

      {error && <p className="rich-error" role="alert" style={{ margin: "10px 20px 0" }}>{error}</p>}

      <ExperienceControls.Provider value={sharedControlsValue}>
        <main className="advisor-split">
          {/* LEFT PANE: Advisor Persona chatting directly with the CEP AI Agent */}
          <section className="advisor-pane advisor-agent-pane" aria-label="Advisor chatting with CEP AI Agent">
            <header className="advisor-pane-head">
              <div className="advisor-pane-title">
                <ProfileAvatar name={advisor.name} />
                <div>
                  <strong>{advisor.name} ↔ CEP AI Agent</strong>
                  <small>Ask the AI Agent to pull data or build an interactive A2UI card for {client?.displayName ?? "your client"}</small>
                </div>
              </div>
              <span className="cobrowse-live-pill">ADVISOR VIEW</span>
            </header>

            <div className="advisor-quick-prompts">
              {ADVISOR_PROMPTS.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  className="rich-action-chip"
                  disabled={sending || Boolean(activeWorkingTurnId)}
                  onClick={() => void askAgent(item.prompt)}
                >
                  <Sparkles size={11} aria-hidden="true" />{item.label}
                </button>
              ))}
            </div>

            <div className="advisor-chat-feed">
              {(!conversation || conversation.turns.length === 0) && (
                <div className="advisor-empty-state">
                  <Sparkles size={22} aria-hidden="true" />
                  <h3>Chat with the CEP AI Agent as {advisor.name}</h3>
                  <p>
                    Pick any quick prompt above or type a question below. As soon as the AI Agent renders an interactive A2UI v1.0 card, both <strong>{advisor.name}</strong> and <strong>{client?.displayName ?? "the client"}</strong> will see the exact same live card simultaneously on the right (and in any open <code>/chat</code> tab).
                  </p>
                </div>
              )}

              {(conversation?.turns ?? []).map((turn) => (
                <div key={turn.id} className="advisor-turn">
                  <div className="advisor-user-bubble">
                    <small>{advisor.name}</small>
                    <p>{turn.message}</p>
                  </div>
                  <div className="advisor-agent-reply">
                    <div className="advisor-agent-reply-head">
                      <span><LabMark small /> <strong>CEP AI Agent</strong></span>
                      {turn.experience && (
                        <button
                          type="button"
                          className={"rich-action-chip" + (ticket?.coBrowse?.sharedCard?.turnId === turn.id ? " is-active" : "")}
                          onClick={() => void pushCardToBoth(turn)}
                        >
                          <Share2 size={12} aria-hidden="true" />
                          {ticket?.coBrowse?.sharedCard?.turnId === turn.id ? "Synced to Client" : "Share Card Live"}
                        </button>
                      )}
                    </div>
                    {turn.status === "working" ? (
                      <p className="advisor-working"><Loader2 size={14} className="reasoning-spinner" /> Preparing verified A2UI card for {client?.displayName}…</p>
                    ) : turn.experience ? (
                      <div className="advisor-inline-card">
                        <ExperienceCanvasView data={turn.experience} />
                      </div>
                    ) : (
                      <p className="rich-muted">Status: {turn.status}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <form
              className="advisor-composer"
              onSubmit={(e) => { e.preventDefault(); void askAgent(draft); }}
            >
              <input
                aria-label="Ask CEP AI Agent as advisor"
                placeholder={`Ask CEP AI Agent on behalf of ${client?.displayName ?? "client"}…`}
                value={draft}
                disabled={sending || Boolean(activeWorkingTurnId)}
                onChange={(e) => setDraft(e.target.value)}
              />
              <button type="submit" className="rich-btn-primary" disabled={sending || Boolean(activeWorkingTurnId) || !draft.trim()}>
                <ArrowUp size={14} aria-hidden="true" />Ask Agent
              </button>
            </form>
          </section>

          {/* RIGHT PANE: Exact Same Shared Card Seen by Both Advisor & Client over Live SSE */}
          <section className="advisor-pane advisor-shared-pane" aria-label="Shared Live Card Stage seen by both Advisor and Client">
            <header className="advisor-pane-head">
              <div className="advisor-pane-title">
                <Users size={18} aria-hidden="true" />
                <div>
                  <strong>Shared Live Card · Seen by Both</strong>
                  <small>Real-time SSE mirror of what {client?.displayName ?? "Client"} &amp; {advisor.name} both see</small>
                </div>
              </div>
              <div className="expertise-dial" role="group" aria-label="Simulate perspective">
                <button type="button" className={"expertise-dial-btn" + (mirrorRole === "customer" ? " is-active" : "")} onClick={() => setMirrorRole("customer")}>
                  Client View ({client?.displayName?.split(" ")[0] ?? "Client"})
                </button>
                <button type="button" className={"expertise-dial-btn" + (mirrorRole === "advisor" ? " is-active" : "")} onClick={() => setMirrorRole("advisor")}>
                  Advisor Push
                </button>
              </div>
            </header>

            <div className="advisor-shared-body">
              <div className="shared-presence-bar">
                <span className="cobrowse-live-pill"><Radio size={11} /> LIVE SSE SYNC</span>
                <span><ProfileAvatar name={advisor.name} /> {advisor.name}</span>
                <span>+</span>
                <span><ProfileAvatar name={client?.displayName ?? "Client"} /> {client?.displayName ?? "Client"}</span>
                {ticket?.coBrowse?.sharedCard && (
                  <code>{ticket.coBrowse.sharedCard.id}</code>
                )}
              </div>

              {sharedExperience ? (
                <div className="shared-card-stage" role="region" aria-label="Synced A2UI card">
                  <div className="shared-card-stage-meta">
                    <strong>Synced A2UI Card</strong>
                    <span>Prompt: &ldquo;{ticket?.coBrowse?.sharedCard?.prompt}&rdquo;</span>
                  </div>
                  <ExperienceCanvasView data={sharedExperience} />
                </div>
              ) : (
                <div className="advisor-empty-state is-stage">
                  <Headphones size={22} aria-hidden="true" />
                  <h4>Waiting for first shared A2UI card</h4>
                  <p>Ask the AI Agent on the left (e.g., click <strong>Client portfolio mix</strong> or <strong>2-year home savings plan</strong>) — the exact same card will lock into this stage for both the advisor and the client.</p>
                </div>
              )}

              {ticket && (
                <MultiplayerCoBrowseCard
                  ticket={ticket}
                  role={mirrorRole}
                  startingBalanceUsd={startingBalanceUsd}
                  onTicketUpdated={setTicket}
                />
              )}

              {ticket && (
                <div className="advisor-live-notes">
                  <span className="rich-kicker">SHARED ROOM MESSAGES ({mirrorRole === "advisor" ? `SENDING AS ${advisor.name}` : `SIMULATING ${client?.displayName ?? "CLIENT"}`})</span>
                  <div className="live-handoff-messages">
                    {ticket.notes.slice(-6).map((n) => (
                      <div key={n.id} className={"handoff-msg is-" + n.role}>
                        <strong>{n.author}:</strong>
                        <span>{n.text}</span>
                      </div>
                    ))}
                  </div>
                  <form className="live-handoff-reply" onSubmit={(e) => void sendLiveNote(e)}>
                    <input
                      aria-label="Send message in shared room"
                      placeholder={mirrorRole === "advisor" ? `Message ${client?.displayName ?? "client"} as ${advisor.name}…` : `Reply as ${client?.displayName ?? "client"}…`}
                      value={noteInput}
                      onChange={(e) => setNoteInput(e.target.value)}
                    />
                    <button type="submit" className="rich-btn-primary" disabled={sendingNote || !noteInput.trim()}>
                      <Send size={13} aria-hidden="true" />Send
                    </button>
                  </form>
                </div>
              )}
            </div>
          </section>
        </main>
      </ExperienceControls.Provider>
    </div>
  );
}
