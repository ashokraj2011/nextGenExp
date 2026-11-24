import { useEffect, useId, useState } from "react";
import { RotateCw } from "lucide-react";
import { adminPaths } from "../../packages/contracts/admin-paths";
import type { Bootstrap, ConversationView } from "../../packages/contracts/api";
import { pendingActionsContext } from "../../packages/contracts/workspace";
import { api, toolSetupErrorMessage } from "./api";
import { diagnosticHref } from "./admin-navigation";
import { CallLogs, PendingActionLogs } from "./call-logs";
import { Inspector } from "./inspector";
import { readActiveConversation, rememberActiveConversation } from "./conversation-storage";

export function AdminDiagnostics({ view, selectThread }: { view: "logs" | "inspector"; selectThread: (id: string) => void }) {
  const selectId = useId();
  const [query] = useState(() => new URLSearchParams(location.search));
  const [configuration, setConfiguration] = useState<Bootstrap>();
  const [selectedId, setSelectedId] = useState("");
  const [conversation, setConversation] = useState<ConversationView>();
  const [notice, setNotice] = useState("");
  const [refresh, setRefresh] = useState(0);
  const path = adminPaths[view];
  const title = view === "logs" ? "Call logs" : "Developer inspector";
  const pendingActionView = view === "logs" && query.get("source") === pendingActionsContext;

  useEffect(() => {
    let active = true;
    void api.adminBootstrap().then((data) => {
      if (!active) return;
      const ids = [query.get("thread"), readActiveConversation(), readActiveConversation(true)];
      const preferred = ids.find((id) => data.conversations.some((item) => item.id === id));
      const id = preferred ?? data.conversations[0]?.id ?? "";
      setSelectedId(id);
      selectThread(id);
      setConfiguration(data);
    }, (error: unknown) => { if (active) setNotice(toolSetupErrorMessage(error)); });
    return () => { active = false; };
  }, [query, selectThread]);

  useEffect(() => {
    if (!selectedId || pendingActionView) return;
    let active = true;
    void api.conversation(selectedId).then((row) => {
      if (active) setConversation(row);
    }, (error: unknown) => { if (active) setNotice(toolSetupErrorMessage(error)); });
    return () => { active = false; };
  }, [selectedId, refresh, pendingActionView]);

  const loaded = conversation?.id === selectedId ? conversation : undefined;
  const requestedTurn = loaded?.id === query.get("thread") ? query.get("turn") ?? undefined : undefined;
  const pendingQuery = new URLSearchParams({ source: pendingActionsContext });
  if (selectedId) pendingQuery.set("thread", selectedId);
  return <main className="admin-main admin-diagnostics" aria-labelledby="diagnostics-title">
    <header className="admin-heading"><h1 id="diagnostics-title">{title}</h1></header>
    {view === "logs" && <nav className="log-sources" aria-label="Log sources">
      <a className="rail-link" aria-current={pendingActionView ? undefined : "page"}
        href={diagnosticHref(adminPaths.logs, selectedId, requestedTurn)}>Chat calls</a>
      <a className="rail-link" aria-current={pendingActionView ? "page" : undefined}
        href={adminPaths.logs + "?" + pendingQuery}>Pending actions</a>
    </nav>}
    {pendingActionView ? <PendingActionLogs profiles={configuration?.personas ?? []} /> : <section className="admin-card diagnostics-picker">
      <label htmlFor={selectId}>Conversation</label>
      <div>
        <select id={selectId} value={selectedId} disabled={!configuration?.conversations.length} onChange={(event) => {
          const id = event.target.value;
          setNotice("");
          setSelectedId(id);
          selectThread(id);
          history.replaceState(history.state, "", diagnosticHref(path, id));
        }}>
          {!configuration?.conversations.length && <option value="">No conversations</option>}
          {configuration?.conversations.map(({ id, title: name, personaId, audience, archivedAt }) => (
            <option key={id} value={id}>
              {name} · {configuration.personas.find((profile) => profile.personaId === personaId)?.displayName ?? personaId}
              {audience === "admin" ? " · Test chat" : ""}{archivedAt !== undefined ? " · Archived" : ""}
            </option>
          ))}
        </select>
        <button className="secondary-button" type="button" disabled={!selectedId} onClick={() => { setNotice(""); setRefresh(refresh + 1); }}>
          <RotateCw size={15} aria-hidden="true" />Refresh
        </button>
      </div>
    </section>}
    {notice && <p className="request-notice" role="alert">{notice}</p>}
    {!pendingActionView && selectedId && !loaded && !notice && <p className="workspace-loading" role="status">Loading conversation…</p>}
    {view === "logs" && !pendingActionView && (!selectedId || loaded) && <CallLogs key={loaded?.id} turns={loaded?.turns ?? []} turnId={requestedTurn} />}
    {view === "inspector" && configuration && (!selectedId || loaded) && <Inspector key={loaded?.id} configuration={configuration}
      conversation={loaded} turnId={requestedTurn} create={async (personaId, scenarioId) => {
        setNotice("");
        try {
          const row = await api.newAdminConversation(personaId, scenarioId);
          rememberActiveConversation(row.id, true);
          location.assign(adminPaths.chat);
          return true;
        } catch (error) {
          setNotice(toolSetupErrorMessage(error));
          return false;
        }
      }} />}
  </main>;
}
