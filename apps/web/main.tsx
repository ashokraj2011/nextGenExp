import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ActionMessage } from "@a2ui/web_core/v1_0";
import {
  ArrowLeft, ChevronDown, ChevronRight, Eye, LayoutDashboard, LogIn, LogOut, PanelLeft, PanelLeftClose, Plus, Sparkles, X,
} from "lucide-react";
import {
  progressLabels, type Bootstrap, type Conversation, type ConversationChange, type ConversationFolder, type ConversationView,
  type DemoPersona, type Progress, type TurnAccepted, type TurnView,
} from "../../packages/contracts/api";
import { defaultWorkspacePins, pendingActionsContext, type WorkspacePin } from "../../packages/contracts/workspace";
import { adminPaths } from "../../packages/contracts/admin-paths";
import { api } from "./api";
import { AdminNavigation } from "./admin-navigation";
import { readActiveConversation, readProfileSession, rememberActiveConversation, saveProfileSession } from "./conversation-storage";
import { DemoProfiles, ProfileAvatar } from "./demo-profiles";
import { useDomainPack } from "./domain-pack-ui";
import { LabMark } from "./lab-mark";
import { planningTopics } from "./planning-topics";
import { applyTheme, readStoredTheme, ThemeToggle } from "./theme";
import { installA2uiStyles } from "./surface";
import { CEP_EMBED_PROTOCOL, type CepEmbedScreenContext } from "../../packages/embed-sdk";
import type { ProactiveAlert } from "../../packages/contracts/proactive-events";
import { usePendingActions } from "./workspace-overview";
import { WorkspaceCustomization, WorkspaceMenu, type WorkspaceSection } from "./workspace-menu";
import { FolderSettings, ThreadList, ThreadSettings, type ThreadBadge } from "./thread-list";
import type { HandoffTicket } from "../../packages/contracts/handoff";
import { isHandoffPhrase, MemoryDrawer, type MemoryEntry } from "./chat-rich-ux";
import type { ExpertiseMode, Watchcard } from "../../packages/contracts/nextgen-chat";
import { ChatToolsMenu, ConsumerA2aDrawer } from "./nextgen-chat-features";
import { ContextHealthPill } from "./context-health-pill";
import { buildWealthDomContext, messageFor } from "./chat/chat-context";
import { Chat } from "./chat/chat-thread";
import "./customer-workbench.css";

const adminChat = location.pathname === adminPaths.chat;
const embedMode = location.pathname === "/embed";
const createConversation = adminChat ? api.newAdminConversation : api.newConversation;

function applyEmbedAccent(accent: string | null) {
  const root = document.documentElement.style;
  if (!accent || !/^#[0-9a-fA-F]{3,8}$/.test(accent.trim())) return;
  const color = accent.trim();
  root.setProperty("--embed-accent", color);
  root.setProperty("--embed-accent-pale", `color-mix(in srgb, ${color} 11%, transparent)`);
  root.setProperty("--embed-accent-border", `color-mix(in srgb, ${color} 34%, transparent)`);
}

function postEmbedEvent(type: string, payload: Record<string, unknown>) {
  if (!embedMode || window.parent === window) return;
  try {
    window.parent.postMessage({ protocol: CEP_EMBED_PROTOCOL, type, payload }, "*");
  } catch { /* ignore cross-origin restrictions */ }
}

type Panel = { kind: "profiles" } | { kind: "pins" } | { kind: "thread"; id: string } | { kind: "folder"; id: string };
const narrowNavigation = "(max-width: 850px)";

function App() {
  const [entry] = useState(() => {
    const query = new URLSearchParams(location.search);
    return {
      topic: planningTopics.find(({ id }) => id === query.get("topic")),
      showProfiles: query.get("view") === "profiles",
      showOverview: query.get("view") === "overview",
      profileId: adminChat ? null : (embedMode ? (query.get("personaId") || readProfileSession() || "demo-learner") : readProfileSession()),
      embedBrand: query.get("brand")?.trim() || "CEP Assistant",
      embedAccent: query.get("accent")?.trim() || "",
      embedPrompt: query.get("prompt")?.trim() || "",
    };
  });
  const [embedBrand, setEmbedBrand] = useState(entry.embedBrand);
  const [embedAccent, setEmbedAccent] = useState(entry.embedAccent);
  const [screenContext, setScreenContext] = useState<CepEmbedScreenContext | null>(null);
  const [ambientDismissed, setAmbientDismissed] = useState(false);
  const [proactiveAlert, setProactiveAlert] = useState<ProactiveAlert | null>(null);
  const [signedInProfileId, setSignedInProfileId] = useState(entry.profileId);
  const [domainPack, setDomainPack] = useDomainPack();
  const [configuration, setConfiguration] = useState<Bootstrap>();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [folders, setFolders] = useState<ConversationFolder[]>([]);
  const [threadBadges, setThreadBadges] = useState<Record<string, ThreadBadge>>({});
  const seenCompletedRef = useRef<Record<string, number>>({});
  const [conversation, setConversation] = useState<ConversationView>();
  const [overviewOpen, setOverviewOpen] = useState(entry.showOverview);
  const [section, setSection] = useState<WorkspaceSection>("summary");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [progressHistory, setProgressHistory] = useState<Record<string, Progress[]>>({});
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [panel, setPanel] = useState<Panel | undefined>(entry.showProfiles ? { kind: "profiles" } : undefined);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [memoryItems, setMemoryItems] = useState<MemoryEntry[]>([]);
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [memoryError, setMemoryError] = useState("");
  const [activeHandoff, setActiveHandoff] = useState<HandoffTicket | null>(null);
  const dismissedHandoffIds = useRef(new Set<string>());
  const [expertiseMode, setExpertiseMode] = useState<ExpertiseMode>(() => {
    try {
      const saved = localStorage.getItem("cep_expertise_mode");
      return saved === "guided" || saved === "pro" ? saved : "standard";
    } catch { return "standard"; }
  });
  const [futuresOpen, setFuturesOpen] = useState(false);
  const [watchcards, setWatchcards] = useState<Watchcard[]>([]);
  const [watchCreatorOpen, setWatchCreatorOpen] = useState(false);
  const [delegateOpen, setDelegateOpen] = useState(false);
  const inFlight = useRef(false);
  const previousAttempt = useRef<{ fingerprint: string; id: string } | null>(null);
  const profilesTrigger = useRef<HTMLButtonElement>(null);
  const customizeTrigger = useRef<HTMLButtonElement>(null);
  const threadTrigger = useRef<HTMLButtonElement | null>(null);
  const newThreadTrigger = useRef<HTMLButtonElement>(null);
  const railTrigger = useRef<HTMLButtonElement>(null);
  const railClose = useRef<HTMLButtonElement>(null);
  const previousPanel = useRef<Panel["kind"] | undefined>(undefined);
  const profilesById = new Map(configuration?.personas.map((persona) => [persona.personaId, persona]));
  const workspaceProfileId = domainPack.id === "wealth" ? signedInProfileId : undefined;
  const activeProfile = profilesById.get(conversation?.personaId ?? workspaceProfileId ?? configuration?.defaultPersonaId ?? "")
    ?? (domainPack.id !== "wealth" ? profilesById.get(configuration?.defaultPersonaId ?? "") : undefined);
  const pins = activeProfile?.pins ?? defaultWorkspacePins;
  const activeSection = section === "summary" || pins.includes(section) ? section : "summary";
  const wealthDomContextJson = useMemo(() => {
    if (adminChat || embedMode || domainPack.id !== "wealth") return undefined;
    const ctx = buildWealthDomContext(activeSection, activeProfile);
    return ctx ? JSON.stringify(ctx) : undefined;
  }, [activeSection, activeProfile, domainPack.id]);

  const chat = overviewOpen || conversation?.domainId !== domainPack.id ? undefined : conversation;
  const pendingActions = usePendingActions(!adminChat && domainPack.id === "wealth" ? activeProfile?.personaId : undefined);
  const draftKey = chat?.id ?? "new:" + (conversation?.personaId ?? signedInProfileId ?? "");
  const latest = chat?.turns.at(-1);
  const activeTurnIds = useMemo(
    () => (chat?.turns ?? []).filter((t) => t.status === "working").map((t) => t.id),
    [chat?.turns],
  );
  const activeTurnKey = activeTurnIds.join(",");
  const scopedPersonaId = adminChat ? null : (workspaceProfileId ?? activeProfile?.personaId ?? null);
  const visibleConversations = conversations.filter((row) => row.domainId === domainPack.id && (!scopedPersonaId || row.personaId === scopedPersonaId));
  const visibleFolders = folders.filter((folder) => folder.domainId === domainPack.id);

  const recordProgress = useCallback((turnId: string, progress: Progress) => {
    setProgressHistory((prev) => {
      const current = prev[turnId] ?? [];
      if (current.includes(progress)) return prev;
      return { ...prev, [turnId]: [...current, progress] };
    });
  }, []);

  const remember = (row: Conversation) => setConversations((list) => (
    [row, ...list.filter((item) => item.id !== row.id)].sort((a, b) => b.updatedAt - a.updatedAt)
  ));
  const choose = (row: ConversationView, showOverview = false) => {
    setConversation(row);
    setOverviewOpen(showOverview);
    remember(row);
    rememberActiveConversation(row.id, adminChat, row.domainId);
    setRailOpen(false);
  };

  useEffect(() => {
    let mounted = true;
    setConversation(undefined);
    setConfiguration(undefined);
    void (adminChat ? api.adminBootstrap(domainPack.id) : api.bootstrap(domainPack.id)).then(async (data) => {
      if (!mounted) return;
      if (data.requiresProfile) {
        if (!embedMode) { location.replace("/login"); return; }
        setNotice("Select a profile on the sign-in page to open this workspace.");
      }
      if (domainPack.id === "wealth" && entry.profileId && !data.personas.some(({ personaId }) => personaId === entry.profileId)) {
        if (!embedMode) {
          location.replace("/login");
          return;
        }
        setSignedInProfileId(data.defaultPersonaId);
      }
      const threads = data.conversations.filter(({ audience, domainId }) => (audience === "admin") === adminChat && domainId === domainPack.id);
      setConversations(threads);
      setFolders(data.folders ?? []);
      const matching = domainPack.id === "wealth" && entry.profileId ? threads.filter((row) => row.personaId === entry.profileId) : threads;
      const preferred = matching.find((row) => row.id === readActiveConversation(adminChat, domainPack.id))
        ?? matching.find(({ archivedAt }) => archivedAt === undefined);
      if (preferred) {
        const restored = await api.conversation(preferred.id);
        if (!mounted) return;
        choose(restored, entry.showOverview);
      }
      const prompt = entry.topic?.prompt;
      if (prompt) {
        const key = preferred?.id ?? "new:" + (entry.profileId ?? "");
        setDrafts((all) => ({ ...all, [key]: all[key] ?? prompt }));
      }
      if (entry.topic || entry.showProfiles || entry.showOverview) history.replaceState(history.state, "", location.pathname + location.hash);
      setConfiguration(data);
    }).catch((error: unknown) => { if (mounted) setNotice(messageFor(error)); });
    return () => { mounted = false; };
  }, [entry, domainPack.id]);

  useEffect(() => {
    const onDomainUpdate = () => {
      void (adminChat ? api.adminBootstrap(domainPack.id) : api.bootstrap(domainPack.id)).then((fresh) => {
        setConfiguration((prev) => (prev ? { ...prev, personas: fresh.personas } : fresh));
      }).catch(() => undefined);
    };
    window.addEventListener("cep-domain-data-updated", onDomainUpdate);
    return () => window.removeEventListener("cep-domain-data-updated", onDomainUpdate);
  }, [domainPack.id]);

  useEffect(() => {
    if (adminChat) return;
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted && readProfileSession() !== signedInProfileId) location.reload();
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, [signedInProfileId]);

  useEffect(() => {
    if (!railOpen) return;
    const trigger = railTrigger.current;
    railClose.current?.focus();
    const handle = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") setRailOpen(false); };
    const layout = window.matchMedia(narrowNavigation);
    const onLayout = () => { if (!layout.matches) setRailOpen(false); };
    window.addEventListener("keydown", handle);
    layout.addEventListener("change", onLayout);
    return () => {
      window.removeEventListener("keydown", handle);
      layout.removeEventListener("change", onLayout);
      if (layout.matches) trigger?.focus();
    };
  }, [railOpen]);

  useLayoutEffect(() => {
    const closed = previousPanel.current;
    previousPanel.current = panel?.kind;
    if (panel || !closed) return;
    const triggers = { profiles: profilesTrigger, pins: customizeTrigger, thread: threadTrigger, folder: threadTrigger };
    const isNavigationPanel = closed !== "pins";
    if (isNavigationPanel && window.matchMedia(narrowNavigation).matches) railTrigger.current?.focus();
    else if (triggers[closed].current?.isConnected) triggers[closed].current?.focus();
    else newThreadTrigger.current?.focus();
  }, [panel]);

  useEffect(() => {
    if (!configuration) return;
    let alive = true;
    const persona = activeProfile?.personaId ?? configuration.defaultPersonaId;
    const syncThreadStatuses = async () => {
      try {
        const res = await api.threadStatus(persona, chat?.id);
        if (!alive) return;
        const rows = [
          ...res.otherThreads,
          ...(res.currentThread ? [{ ...res.currentThread, title: chat?.title ?? "", status: "" }] : []),
        ];
        setThreadBadges((prev) => {
          const next: Record<string, ThreadBadge> = {};
          for (const row of rows) {
            const seen = seenCompletedRef.current[row.conversationId];
            const isActive = row.conversationId === chat?.id;
            if (isActive || seen === undefined) {
              seenCompletedRef.current[row.conversationId] = row.completedTurns;
            }
            const unread = !isActive && seen !== undefined && (row.completedTurns > seen || Boolean(prev[row.conversationId]?.unread));
            next[row.conversationId] = { running: row.runningTurns > 0, unread };
          }
          return next;
        });
      } catch { /* ignore polling errors */ }
    };
    void syncThreadStatuses();
    const timer = setInterval(() => void syncThreadStatuses(), 4000);
    return () => { alive = false; clearInterval(timer); };
  }, [configuration, activeProfile?.personaId, chat?.id, chat?.title, activeTurnKey]);

  const upsert = useCallback((turn: TurnView) => {
    recordProgress(turn.id, turn.progress);
    setConversation((previous) => {
      if (!previous || previous.id !== turn.conversationId) return previous;
      const existing = previous.turns.find((item) => item.id === turn.id);
      if (existing) {
        if (existing.status !== "working" && turn.status === "working") return previous;
        return { ...previous, turns: previous.turns.map((item) => item.id === turn.id ? turn : item) };
      }
      return { ...previous, turns: [...previous.turns, turn] };
    });
  }, [recordProgress]);

  useEffect(() => {
    if (!activeTurnKey) return;
    const ids = activeTurnKey.split(",").filter(Boolean);
    let alive = true;
    const cleanups = ids.map((id) => {
      let seen = 0;
      const stream = new EventSource("/api/turns/" + id + "/events");
      const refresh = () => void api.turn(id).then((snapshot) => {
        if (!alive) return;
        upsert(snapshot);
        if (snapshot.status !== "working") stream.close();
      }).catch(() => { /* EventSource reconnects with the last event ID. */ });
      stream.addEventListener("turn.status", (event) => {
        const sequence = Number(event.lastEventId);
        if (sequence <= seen) return;
        seen = sequence;
        const payload = JSON.parse(event.data).payload as { progress?: Progress; harnessStage?: NonNullable<TurnView["harnessStages"]>[number] };
        const progress = payload.progress;
        if (progress && Object.hasOwn(progressLabels, progress)) recordProgress(id, progress);
        setConversation((previous) => previous ? {
          ...previous,
          turns: previous.turns.map((turn) => {
            if (turn.id !== id || turn.status !== "working") return turn;
            const nextStages = payload.harnessStage
              ? [...(turn.harnessStages ?? []), payload.harnessStage].slice(-8)
              : turn.harnessStages;
            return {
              ...turn,
              ...(progress && Object.hasOwn(progressLabels, progress) ? { progress } : {}),
              ...(nextStages ? { harnessStages: nextStages } : {}),
            };
          }),
        } : previous);
      });
      for (const type of ["experience.ready", "turn.failed", "turn.cancelled", "gap", "error"]) stream.addEventListener(type, refresh);
      const recoveryPoll = setInterval(refresh, 4000);
      return () => { stream.close(); clearInterval(recoveryPoll); };
    });
    return () => {
      alive = false;
      for (const cleanup of cleanups) cleanup();
    };
  }, [activeTurnKey, upsert, recordProgress]);

  const exclusive = async (task: () => Promise<void>) => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setPending(true);
    setNotice("");
    try { await task(); return true; } catch (error) {
      setNotice(messageFor(error));
      return false;
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  const requestId = (fingerprint: string) => {
    if (previousAttempt.current?.fingerprint === fingerprint) return previousAttempt.current.id;
    const id = crypto.randomUUID();
    previousAttempt.current = { fingerprint, id };
    return id;
  };
  const accept = ({ turn, conversation: row }: TurnAccepted) => {
    previousAttempt.current = null;
    upsert(turn);
    remember(row);
    setConversation((current) => current?.id === row.id ? { ...current, ...row } : current);
  };

  const startHandoff = useCallback(async (reason?: string) => {
    const convId = chat?.id ?? `conv_${crypto.randomUUID().slice(0, 10)}`;
    const personaId = activeProfile?.personaId ?? configuration?.defaultPersonaId ?? "demo-learner";
    const domain = domainPack.id === "it_ops" ? "operations" : domainPack.id === "sales_revops" ? "sales" : "wealth";
    try {
      const res = await api.createHandoff({
        conversationId: convId,
        personaId,
        domain,
        reason: (reason?.trim() || "Customer requested a live specialist from chat.").slice(0, 400),
      });
      setActiveHandoff(res.ticket);
      setOverviewOpen(false);
      setSection("summary");
    } catch (error) {
      setNotice(messageFor(error));
    }
  }, [activeProfile?.personaId, chat?.id, configuration?.defaultPersonaId, domainPack.id]);

  const loadMemory = useCallback(async () => {
    if (!configuration?.gatewayConfigured) return;
    setMemoryLoading(true);
    setMemoryError("");
    try {
      const res = await api.memoryList();
      setMemoryItems(res.items);
    } catch (error) {
      setMemoryError(messageFor(error));
    } finally {
      setMemoryLoading(false);
    }
  }, [configuration?.gatewayConfigured]);

  useEffect(() => {
    if (configuration?.gatewayConfigured) void loadMemory();
  }, [configuration?.gatewayConfigured, loadMemory]);

  const changeExpertiseMode = useCallback((next: ExpertiseMode) => {
    setExpertiseMode(next);
    try { localStorage.setItem("cep_expertise_mode", next); } catch { /* ignore */ }
    if (configuration?.gatewayConfigured) {
      void api.memorySave({ kind: "preference", key: "ui_expertise_mode", content: `Preferred chat complexity dial: ${next}` })
        .then((res) => setMemoryItems(res.items))
        .catch(() => undefined);
    }
  }, [configuration?.gatewayConfigured]);

  useEffect(() => {
    if (adminChat || !activeProfile) return;
    let alive = true;
    const syncActiveHandoff = () => {
      void api.activeHandoff(activeProfile.personaId).then((res) => {
        if (!alive) return;
        if (res.ticket && !dismissedHandoffIds.current.has(res.ticket.handoffId)) {
          setActiveHandoff((prev) => (prev?.handoffId === res.ticket!.handoffId && prev.updatedAt === res.ticket!.updatedAt ? prev : res.ticket));
        } else if (!res.ticket) {
          setActiveHandoff(null);
        }
      }).catch(() => undefined);
    };
    syncActiveHandoff();
    const timer = setInterval(syncActiveHandoff, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [activeProfile?.personaId, adminChat]);

  useEffect(() => {
    if (adminChat || !activeProfile) return;
    let alive = true;
    void api.listWatchcards(activeProfile.personaId).then((res) => {
      if (alive) setWatchcards(res.watchcards);
    }).catch(() => undefined);
    const stream = new EventSource("/api/watchcards/stream?personaId=" + encodeURIComponent(activeProfile.personaId));
    stream.addEventListener("watchcard.update", (evt) => {
      if (!alive) return;
      try {
        const updated = JSON.parse((evt as MessageEvent).data) as Watchcard;
        setWatchcards((prev) => {
          if (updated.status === "dismissed") return prev.filter((c) => c.id !== updated.id);
          const exists = prev.some((c) => c.id === updated.id);
          return exists ? prev.map((c) => (c.id === updated.id ? updated : c)) : [updated, ...prev];
        });
      } catch { /* ignore */ }
    });
    return () => { alive = false; stream.close(); };
  }, [activeProfile?.personaId, adminChat]);

  const send = async (message: string) => {
    if (!configuration) return;
    if (!adminChat && isHandoffPhrase(message)) {
      void startHandoff(message);
    }
    await exclusive(async () => {
      const target = chat ?? await createConversation(activeProfile?.personaId ?? configuration.defaultPersonaId, configuration.defaultScenarioId, domainPack.id);
      if (!chat) choose(target);
      setSection("summary");
      try {
        accept(await api.send(target.id, message, requestId(target.id + ":" + message)));
        setDrafts((all) => ({ ...all, [draftKey]: all[draftKey]?.trim() === message ? "" : all[draftKey] }));
      } catch (error) {
        if (!chat) setDrafts((all) => ({ ...all, [target.id]: all[draftKey] ?? message }));
        throw error;
      }
    });
  };
  const previewFunding = (source?: typeof pendingActionsContext) => {
    if (!configuration || !activeProfile) return;
    void exclusive(async () => {
      const target = chat && !chat.turns.length && chat.scenarioId === configuration.defaultScenarioId
        ? chat : await createConversation(activeProfile.personaId, configuration.defaultScenarioId, domainPack.id);
      choose(target);
      setSection("summary");
      accept(await api.previewFunding(target.id, requestId(target.id + ":preview-funding:" + (source ?? "overview")), source));
    });
  };
  const revealChat = (row: ConversationView) => {
    setSection("summary");
    choose(row);
    if (!adminChat && !row.turns.length) pendingActions.refresh();
  };
  const startConversation = async (personaId: string, scenarioId: string, folderId?: string) => exclusive(async () => {
    const row = await createConversation(personaId, scenarioId, domainPack.id, folderId);
    if (domainPack.id === "wealth" && signedInProfileId && signedInProfileId !== row.personaId) {
      if (!saveProfileSession(row.personaId)) throw new Error("Couldn’t switch profiles in this tab. Please try again.");
      setSignedInProfileId(row.personaId);
    }
    revealChat(row);
  });
  const changeConversation = async (id: string, change: ConversationChange) => exclusive(async () => {
    const updated = await api.changeConversation(id, change);
    remember(updated);
    setConversation((current) => current?.id === id ? { ...current, ...updated, archivedAt: updated.archivedAt, folderId: updated.folderId } : current);
    if (change.operation === "archive" && readActiveConversation(adminChat, domainPack.id) === id) {
      rememberActiveConversation(null, adminChat, domainPack.id);
      setOverviewOpen(true);
      setSection("summary");
    }
  });
  const createFolder = async (name: string): Promise<ConversationFolder | null> => {
    let created: ConversationFolder | null = null;
    await exclusive(async () => {
      const res = await api.createFolder(name, domainPack.id);
      created = res.folder;
      setFolders((list) => [...list.filter((item) => item.id !== res.folder.id), res.folder]);
    });
    return created;
  };
  const renameFolder = async (id: string, name: string) => exclusive(async () => {
    const res = await api.renameFolder(id, name);
    setFolders((list) => list.map((item) => item.id === id ? res.folder : item));
  });
  const updateFolder = async (id: string, patch: { name?: string; instructions?: string | null }) => exclusive(async () => {
    const res = await api.updateFolder(id, patch);
    setFolders((list) => list.map((item) => item.id === id ? res.folder : item));
  });
  const deleteFolder = async (id: string) => exclusive(async () => {
    await api.deleteFolder(id);
    setFolders((list) => list.filter((item) => item.id !== id));
    setConversations((list) => list.map((row) => row.folderId === id ? { ...row, folderId: undefined } : row));
    setConversation((current) => current?.folderId === id ? { ...current, folderId: undefined } : current);
  });
  const branchFromTurn = (turn: TurnView) => {
    if (!chat) return;
    void exclusive(async () => {
      const forked = await api.forkConversation(chat.id, { turnId: turn.id });
      revealChat(forked);
    });
  };
  const summarizeFolder = (folder: ConversationFolder) => {
    if (!configuration) return;
    const prompt = `Summarize all threads in my ${folder.name} folder.`;
    if (chat?.folderId === folder.id) {
      void send(prompt);
      return;
    }
    void exclusive(async () => {
      const personaId = activeProfile?.personaId ?? configuration.defaultPersonaId;
      const target = await createConversation(personaId, configuration.defaultScenarioId, domainPack.id, folder.id);
      revealChat(target);
      accept(await api.send(target.id, prompt, requestId(target.id + ":" + prompt)));
    });
  };
  const savePins = async (next: WorkspacePin[]) => {
    if (!activeProfile) return false;
    return exclusive(async () => {
      const updated = await api.savePins(activeProfile.personaId, next);
      setConfiguration((current) => current && {
        ...current, personas: current.personas.map((profile) => profile.personaId === activeProfile.personaId ? { ...profile, pins: updated } : profile),
      });
      if (section !== "summary" && !updated.includes(section)) setSection("summary");
    });
  };
  const signOut = async () => {
    try { await api.selectProfile(null); }
    catch { setNotice("Couldn’t sign out. Please try again."); return; }
    if (saveProfileSession(null)) location.replace("/login");
    else setNotice("Couldn’t sign out in this tab. Please try again.");
  };
  const openPanel = (next: Panel) => {
    setRailOpen(false);
    if (next.kind === "thread" || next.kind === "pins") setNotice("");
    setPanel(next);
  };
  const closePanel = () => setPanel(undefined);
  const startFreshChat = () => {
    if (configuration) void startConversation(conversation?.personaId ?? signedInProfileId ?? configuration.defaultPersonaId, conversation?.scenarioId ?? configuration.defaultScenarioId);
  };

  const sendRef = useRef(send);
  sendRef.current = send;
  const startConversationRef = useRef(startConversation);
  startConversationRef.current = startConversation;
  const embedReadyPosted = useRef(false);
  const lastBalanceSig = useRef("");
  const lastTurnPosted = useRef("");

  useEffect(() => {
    if (!embedMode) return;
    applyEmbedAccent(embedAccent);
  }, [embedAccent]);

  useEffect(() => {
    if (!embedMode) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { protocol?: string; type?: string; payload?: Record<string, unknown> } | null;
      if (!data || data.protocol !== CEP_EMBED_PROTOCOL || typeof data.type !== "string") return;
      const payload = data.payload ?? {};
      if (data.type === "cep:send_prompt" && typeof payload.prompt === "string" && payload.prompt.trim()) {
        void sendRef.current(payload.prompt.trim());
      } else if (data.type === "cep:set_theme" && (payload.theme === "dark" || payload.theme === "light")) {
        applyTheme(payload.theme);
      } else if (data.type === "cep:set_domain" && (payload.domain === "wealth" || payload.domain === "it_ops" || payload.domain === "sales_revops")) {
        setDomainPack(payload.domain);
      } else if (data.type === "cep:set_brand") {
        if (typeof payload.brand === "string" && payload.brand.trim()) setEmbedBrand(payload.brand.trim());
        if (typeof payload.accent === "string" && payload.accent.trim()) setEmbedAccent(payload.accent.trim());
      } else if (data.type === "cep:set_persona" && typeof payload.personaId === "string" && configuration) {
        void startConversationRef.current(payload.personaId, configuration.defaultScenarioId);
      } else if (data.type === "cep:screen_context" && typeof payload.label === "string" && payload.label.trim()) {
        setScreenContext({
          id: typeof payload.id === "string" ? payload.id : "screen",
          label: payload.label.trim(),
          viewType: typeof payload.viewType === "string" ? payload.viewType : "host_view",
          summary: typeof payload.summary === "string" ? payload.summary : "",
          metrics: Array.isArray(payload.metrics) ? (payload.metrics as { label: string; value: string }[]).slice(0, 4) : [],
          suggestedActions: Array.isArray(payload.suggestedActions)
            ? (payload.suggestedActions as { label: string; prompt: string }[]).slice(0, 4)
            : [],
        });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [configuration, setDomainPack]);

  useEffect(() => {
    if (!embedMode || !configuration || !activeProfile || embedReadyPosted.current) return;
    embedReadyPosted.current = true;
    postEmbedEvent("cep:ready", {
      personaId: activeProfile.personaId,
      displayName: activeProfile.displayName,
      domain: domainPack.id,
      theme: readStoredTheme(),
    });
    if (entry.embedPrompt) {
      void sendRef.current(entry.embedPrompt);
    }
  }, [configuration, activeProfile, domainPack.id, entry.embedPrompt]);

  useEffect(() => {
    if (!embedMode || !activeProfile?.overview?.portfolio) return;
    const p = activeProfile.overview.portfolio;
    const totalCents = p.cashCents + p.equityCents + p.fixedIncomeCents;
    const sig = `${activeProfile.personaId}:${p.cashCents}:${p.equityCents}:${totalCents}`;
    if (sig === lastBalanceSig.current) return;
    lastBalanceSig.current = sig;
    postEmbedEvent("cep:balance_updated", {
      personaId: activeProfile.personaId,
      displayName: activeProfile.displayName,
      cashCents: p.cashCents,
      equityCents: p.equityCents,
      totalCents,
    });
  }, [activeProfile]);

  useEffect(() => {
    if (!embedMode || !latest || latest.status === "working") return;
    const key = `${latest.id}:${latest.status}`;
    if (key === lastTurnPosted.current) return;
    lastTurnPosted.current = key;
    const intro = (latest.experience?.messages?.[0]?.createSurface?.dataModel as { intro?: string } | undefined)?.intro;
    postEmbedEvent("cep:turn_completed", {
      turnId: latest.id,
      message: latest.message,
      status: latest.status,
      ...(intro ? { summary: intro } : {}),
    });
  }, [latest]);

  useEffect(() => {
    setProactiveAlert(null);
    if (adminChat || !activeProfile) return;
    let alive = true;
    const stream = new EventSource("/api/proactive/stream?personaId=" + encodeURIComponent(activeProfile.personaId));
    stream.addEventListener("proactive.alert", (evt) => {
      if (!alive) return;
      try {
        const alert = JSON.parse((evt as MessageEvent).data) as ProactiveAlert;
        if (alert.domain !== domainPack.id) return;
        setProactiveAlert(alert);
        postEmbedEvent("cep:proactive_alert", {
          id: alert.id,
          eventType: alert.eventType,
          severity: alert.severity,
          domain: alert.domain,
          title: alert.title,
          metricValue: alert.metricValue,
        });
      } catch { /* ignore */ }
    });
    return () => {
      alive = false;
      stream.close();
    };
  }, [activeProfile?.personaId, adminChat, domainPack.id]);

  const modelStatus = adminChat
    ? (configuration?.gatewayConfigured ? "Model connected" : "Model offline")
    : configuration?.gatewayConfigured ? (configuration.copilotModel || configuration.openAiModel
      ? `Live · ${configuration.copilotModel ?? configuration.openAiModel}` : "Live Advisory") : "Model offline";
  const managedThread = panel?.kind === "thread" ? visibleConversations.find(({ id }) => id === panel.id) : undefined;
  const managedFolder = panel?.kind === "folder" ? visibleFolders.find(({ id }) => id === panel.id) : undefined;
  const canRunRailActions = Boolean(configuration) && !pending && latest?.status !== "working";

  return <div className={"app-layout" + (embedMode ? " embed-layout" : "") + (railCollapsed ? " rail-collapsed" : "")}>
    {!embedMode && railOpen && <button className="rail-scrim" aria-label="Close conversations" onClick={() => setRailOpen(false)} />}
    {!embedMode && <aside className={"rail" + (railOpen ? " rail-open" : "")} id="conversation-rail" aria-label="Workspace navigation">
      <div className="rail-header">
        <a className="rail-home" href={adminChat ? adminPaths.tools : domainPack.path}>
          <LabMark />
          <span className="rail-brand-text">
            <strong>{adminChat ? "Administration" : "CEP"}</strong>
            {!adminChat && <small>{domainPack.label}</small>}
          </span>
        </a>
        <button className="icon-button rail-collapse-desktop" type="button" aria-label="Collapse sidebar" title="Collapse sidebar"
          onClick={() => setRailCollapsed(true)}><PanelLeftClose size={17} aria-hidden="true" /></button>
        <button className="icon-button rail-close" ref={railClose} aria-label="Close conversation navigation" onClick={() => setRailOpen(false)}><X size={20} /></button>
      </div>
      <button ref={newThreadTrigger} type="button" className="new-conversation" disabled={pending || !configuration} onClick={startFreshChat}>
        <Plus size={17} aria-hidden="true" />New conversation
      </button>
      <div className="rail-section rail-workbench-nav">
        <button type="button" className="rail-link rail-overview" aria-current={!chat ? "page" : undefined} disabled={pending}
          onClick={() => {
            setOverviewOpen(true);
            setSection("summary");
            setRailOpen(false);
            setNotice("");
            if (!adminChat) pendingActions.refresh();
          }}>
          <LayoutDashboard size={16} aria-hidden="true" />Overview
        </button>
      </div>
      <ThreadList threads={visibleConversations} folders={visibleFolders} profiles={profilesById} activeId={chat?.id}
        showNames={adminChat} pending={pending || !configuration} threadBadges={threadBadges}
        open={(id) => {
          setThreadBadges((prev) => prev[id] ? { ...prev, [id]: { ...prev[id], unread: false } } : prev);
          void exclusive(async () => revealChat(await api.conversation(id)));
        }}
        manage={(id, trigger) => { threadTrigger.current = trigger; openPanel({ kind: "thread", id }); }}
        onCreateFolder={createFolder}
        onRenameFolder={renameFolder}
        onDeleteFolder={deleteFolder}
        onMoveThread={(threadId, folderId) => changeConversation(threadId, { operation: "move", folderId })}
        onNewInFolder={(folderId) => {
          if (configuration) void startConversation(conversation?.personaId ?? signedInProfileId ?? configuration.defaultPersonaId, conversation?.scenarioId ?? configuration.defaultScenarioId, folderId);
        }}
        onOpenFolderSettings={(folder) => openPanel({ kind: "folder", id: folder.id })} />
      {!adminChat && (
        <section className="rail-section rail-topics" aria-label="Quick planning topics">
          <h2>{domainPack.id === "wealth" ? "Topics" : `${domainPack.shortLabel} Actions`}</h2>
          <nav>
            {domainPack.id === "wealth"
              ? planningTopics.map(({ id, name, prompt, Icon }) => (
                  <button key={id} type="button" className="rail-link" disabled={!canRunRailActions} onClick={() => {
                    setRailOpen(false);
                    void send(prompt);
                  }}>
                    <Icon size={15} aria-hidden="true" />{name}
                  </button>
                ))
              : domainPack.topics.map(({ id, name, prompt }) => (
                  <button key={id} type="button" className="rail-link" disabled={!canRunRailActions} onClick={() => {
                    setRailOpen(false);
                    void send(prompt);
                  }}>
                    <Sparkles size={14} aria-hidden="true" />{name}
                  </button>
                ))}
          </nav>
        </section>
      )}
      {adminChat && <section className="rail-section rail-tools"><AdminNavigation thread={chat?.id} /></section>}
      <div className="rail-footer">
        {activeProfile && <button ref={profilesTrigger} className="rail-profile" type="button" aria-haspopup="dialog"
          aria-label={"Profiles, current profile " + activeProfile.displayName}
          onClick={() => openPanel({ kind: "profiles" })}>
          <ProfileAvatar name={activeProfile.displayName} />
          <span className="rail-profile-copy"><strong>{activeProfile.displayName}</strong><small>Switch profile</small></span>
          <ChevronDown size={14} aria-hidden="true" />
        </button>}
        {adminChat ? <a className="rail-account" href="/chat"><ArrowLeft size={16} aria-hidden="true" />Customer view</a> : signedInProfileId
          ? <button type="button" className="rail-account" onClick={signOut}><LogOut size={16} aria-hidden="true" />Sign out</button>
          : <a className="rail-account" href="/login"><LogIn size={16} aria-hidden="true" />Sign in</a>}
      </div>
    </aside>}
    <main
      className="workspace"
      inert={railOpen}
      data-expertise={expertiseMode}
      data-cep-active={wealthDomContextJson ? "true" : undefined}
      data-cep-context={wealthDomContextJson}
    >
      {embedMode ? (
        <header className="topbar embed-topbar">
          <div className="embed-topbar-brand">
            <span className="embed-brand-dot" aria-hidden="true" />
            <div className="embed-brand-copy">
              <strong>{embedBrand}</strong>
              <small>{activeProfile?.displayName ?? "Client"} · {domainPack.label}</small>
            </div>
          </div>
          <div className="embed-topbar-actions">
            <button type="button" className="embed-new-btn" disabled={pending || !configuration} onClick={startFreshChat} title="Start new conversation">
              <Plus size={14} aria-hidden="true" />New
            </button>
            <ThemeToggle compact />
          </div>
        </header>
      ) : (
        <header className="topbar unified-topbar">
          <div className="topbar-left">
            <button className="icon-button rail-menu" ref={railTrigger} type="button" aria-label="Show conversations" aria-expanded={railOpen}
              aria-controls="conversation-rail" onClick={() => setRailOpen((open) => !open)}><PanelLeft size={19} aria-hidden="true" /></button>
            {railCollapsed && (
              <button className="icon-button rail-expand-desktop" type="button" aria-label="Expand sidebar" title="Expand sidebar"
                onClick={() => setRailCollapsed(false)}><PanelLeft size={18} aria-hidden="true" /></button>
            )}
            <span className="workspace-crumb">
              {adminChat ? "Admin chat" : (domainPack.id === "wealth" ? (activeProfile?.displayName ?? "Workspace") : domainPack.label)}
              <ChevronRight size={13} aria-hidden="true" />
            </span>
            <h1>{chat?.title ?? "Overview"}</h1>
          </div>
          {domainPack.id === "wealth" && (
            <div className="topbar-center">
              <WorkspaceMenu pins={pins} section={activeSection} onSelect={setSection} onCustomize={() => openPanel({ kind: "pins" })}
                trigger={customizeTrigger} disabled={!configuration} />
            </div>
          )}
          <div className="topbar-actions">
            {!adminChat && (
              <>
                <ContextHealthPill
                  conversationId={chat?.id}
                  turnCount={chat?.turns.filter((t) => t.status === "completed").length ?? 0}
                  disabled={!configuration}
                />
                <ChatToolsMenu
                expertiseMode={expertiseMode}
                onChangeExpertise={changeExpertiseMode}
                futuresOpen={futuresOpen}
                onToggleFutures={() => setFuturesOpen((v) => !v)}
                watchCount={watchcards.length}
                watchTriggered={watchcards.some((w) => w.status === "triggered")}
                onToggleWatch={() => setWatchCreatorOpen((v) => !v)}
                onOpenDelegate={() => setDelegateOpen(true)}
                gatewayConfigured={Boolean(configuration?.gatewayConfigured)}
                memoryCount={memoryItems.length}
                onOpenMemory={() => { setMemoryOpen(true); void loadMemory(); }}
                handoffActive={Boolean(activeHandoff)}
                onStartHandoff={() => void startHandoff()}
              />
              </>
            )}
            <ThemeToggle compact />
            {adminChat && configuration && (
              <span className="model-status" data-connected={configuration.gatewayConfigured}>
                <span aria-hidden="true" />{modelStatus}
              </span>
            )}
          </div>
        </header>
      )}
      {embedMode && screenContext && !ambientDismissed && (
        <section className="embed-ambient-bar" aria-label="Your snapshot and suggestions">
          <div className="embed-ambient-top">
            <div className="embed-ambient-title">
              <span className="embed-ambient-pill">
                <Sparkles size={12} aria-hidden="true" />
                For you
              </span>
              <strong>{screenContext.label}</strong>
            </div>
            <div className="embed-ambient-right">
              {screenContext.metrics && screenContext.metrics.length > 0 && (
                <div className="embed-ambient-metrics">
                  {screenContext.metrics.map((m) => (
                    <span key={`${m.label}-${m.value}`} className="embed-ambient-metric">
                      {m.label}: <b>{m.value}</b>
                    </span>
                  ))}
                </div>
              )}
              {!embedMode && (
                <button
                  type="button"
                  className="icon-button embed-ambient-close"
                  aria-label="Hide suggestions"
                  title="Hide suggestions"
                  onClick={() => setAmbientDismissed(true)}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              )}
            </div>
          </div>
          {screenContext.summary && <p className="embed-ambient-summary">{screenContext.summary}</p>}
          {screenContext.suggestedActions && screenContext.suggestedActions.length > 0 && (
            <div className="embed-ambient-actions">
              {screenContext.suggestedActions.map((act) => (
                <button
                  key={act.label}
                  type="button"
                  className="embed-ambient-action-btn"
                  disabled={pending || !configuration || latest?.status === "working"}
                  onClick={() => void send(act.prompt)}
                >
                  <Sparkles size={12} aria-hidden="true" />
                  {act.label}
                </button>
              ))}
            </div>
          )}
        </section>
      )}
      {proactiveAlert && (
        <div className={`proactive-banner is-${proactiveAlert.severity}`} role="status">
          <div className="proactive-banner-copy">
            <span className="proactive-badge">{proactiveAlert.metricLabel}: <strong>{proactiveAlert.metricValue}</strong></span>
            <div>
              <strong>{proactiveAlert.title}</strong>
              <p>{proactiveAlert.summary}</p>
            </div>
          </div>
          <div className="proactive-banner-actions">
            <button
              type="button"
              className="proactive-cta-btn"
              onClick={() => {
                const target = proactiveAlert;
                setProactiveAlert(null);
                void api.dismissProactiveAlert(target.id).catch(() => undefined);
                void send(target.ctaPrompt);
              }}
            >
              <Sparkles size={13} aria-hidden="true" />
              {proactiveAlert.ctaLabel}
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Dismiss proactive alert"
              onClick={() => {
                const id = proactiveAlert.id;
                setProactiveAlert(null);
                void api.dismissProactiveAlert(id).catch(() => undefined);
              }}
            >
              <X size={15} aria-hidden="true" />
            </button>
          </div>
        </div>
      )}
      <Chat key={draftKey} adminChat={adminChat} conversation={chat} configuration={configuration} activeProfile={activeProfile}
        pendingActions={pendingActions} pending={pending} section={activeSection} pins={pins} progressHistory={progressHistory}
        domainPack={domainPack}
        onSelect={setSection} onPreviewFunding={previewFunding}
        onRestore={() => { if (chat) void changeConversation(chat.id, { operation: "restore" }); }}
        onWriteBack={activeProfile ? async (updates) => {
          const { updatedFields } = await api.applyCustomerBindings(activeProfile.personaId, updates);
          if (updatedFields.length > 0) {
            void (adminChat ? api.adminBootstrap(domainPack.id) : api.bootstrap(domainPack.id)).then((fresh) => {
              setConfiguration(fresh);
            }).catch(() => undefined);
          }
          return updatedFields;
        } : undefined}
        draft={drafts[draftKey] ?? ""} onDraft={(value) => setDrafts((all) => ({ ...all, [draftKey]: value }))} notice={notice}
        onSend={send} onStop={async () => {
          if (activeTurnIds.length) {
            await exclusive(async () => {
              const results = await Promise.all(activeTurnIds.map((id) => api.cancel(id)));
              for (const row of results) upsert(row);
            });
          }
        }}
        onRetry={(id) => {
          if (chat) void exclusive(async () => accept(await api.retry(id, requestId("retry:" + id))));
        }}
        onBranch={branchFromTurn}
        onFollowUp={(id, envelope) => {
          if (chat) void exclusive(async () => accept(await api.followUp(id, envelope, requestId("action:" + String(envelope.action.context.actionId) + ":" + JSON.stringify(envelope.action.context.values ?? null)))));
        }}
        onFeedback={(turnId, expId, value) => {
          void api.event(expId, value).then(() => api.turn(turnId)).then(upsert).catch((error) => setNotice(messageFor(error)));
        }}
        activeHandoff={activeHandoff}
        onStartHandoff={(reason) => void startHandoff(reason)}
        onDismissHandoff={() => {
          if (activeHandoff) {
            dismissedHandoffIds.current.add(activeHandoff.handoffId);
            void api.closeHandoff(activeHandoff.handoffId).catch(() => undefined);
          }
          setActiveHandoff(null);
        }}
        onOpenMemory={() => { setMemoryOpen(true); void loadMemory(); }}
        expertiseMode={expertiseMode}
        futuresOpen={futuresOpen}
        onToggleFutures={(open) => setFuturesOpen((v) => (open === undefined ? !v : open))}
        watchcards={watchcards}
        onWatchcardsChange={setWatchcards}
        watchCreatorOpen={watchCreatorOpen}
        onToggleWatchCreator={(open) => setWatchCreatorOpen((v) => (open === undefined ? !v : open))}
        onOpenDelegate={() => setDelegateOpen(true)} />
    </main>
    <ConsumerA2aDrawer
      open={delegateOpen}
      personaId={activeProfile?.personaId ?? configuration?.defaultPersonaId ?? "demo-learner"}
      onClose={() => setDelegateOpen(false)}
    />
    <MemoryDrawer
      open={memoryOpen}
      items={memoryItems}
      loading={memoryLoading}
      error={memoryError}
      onClose={() => setMemoryOpen(false)}
      onSave={async (kind, content) => {
        const res = await api.memorySave({ kind, content });
        setMemoryItems(res.items);
      }}
      onForget={async (id) => {
        const res = await api.memoryForget(id);
        setMemoryItems(res.items);
      }}
    />
    {configuration && activeProfile && panel?.kind === "profiles" && <DemoProfiles personas={configuration.personas}
      activePersonaId={activeProfile.personaId} pending={pending} close={closePanel}
      startChat={(personaId) => startConversation(personaId, configuration.defaultScenarioId)} />}
    {panel?.kind === "pins" && <WorkspaceCustomization key={activeProfile?.personaId} initial={pins} pending={pending} notice={notice} close={closePanel} save={savePins} />}
    {managedThread && <ThreadSettings key={managedThread.id} thread={managedThread} folders={visibleFolders} pending={pending} notice={notice} close={closePanel}
      change={(input) => changeConversation(managedThread.id, input)} />}
    {managedFolder && (
      <FolderSettings
        key={managedFolder.id}
        folder={managedFolder}
        threadCount={visibleConversations.filter((c) => c.folderId === managedFolder.id && c.archivedAt === undefined).length}
        pending={pending}
        notice={notice}
        close={closePanel}
        onUpdate={(patch) => updateFolder(managedFolder.id, patch)}
        onSummarize={() => summarizeFolder(managedFolder)}
      />
    )}
  </div>;
}

installA2uiStyles();
const root = createRoot(document.getElementById("root")!);
document.title = (adminChat ? "Admin chat" : "Assistant") + " · CEP";
root.render(<App />);
