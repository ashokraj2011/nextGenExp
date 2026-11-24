import { useId, useState } from "react";
import { Archive, Ellipsis, MessageSquare, Pencil, Search } from "lucide-react";
import type { Conversation, ConversationChange, DemoPersona } from "../../packages/contracts/api";
import { DeveloperDrawer } from "./developer-drawer";

export function ThreadList({ threads, profiles, activeId, showNames, pending, open, manage }: {
  threads: Conversation[]; profiles: Map<string, DemoPersona>; activeId?: string;
  showNames: boolean; pending: boolean; open: (id: string) => void;
  manage: (id: string, trigger: HTMLButtonElement) => void;
}) {
  const heading = useId();
  const [search, setSearch] = useState("");
  const [archived, setArchived] = useState(false);
  const query = search.trim().toLowerCase();
  const matching = threads.filter((thread) => (thread.archivedAt !== undefined) === archived
    && thread.title.toLowerCase().includes(query));
  return <section className="rail-section rail-threads" aria-labelledby={heading}>
    <div className="rail-thread-heading">
      <h2 id={heading}>Chat threads</h2>
      <button className="archive-toggle icon-button" type="button" aria-label="Archived conversations"
        aria-pressed={archived} title={archived ? "Show active conversations" : "Show archived conversations"}
        onClick={() => setArchived(!archived)}><Archive size={15} aria-hidden="true" /></button>
    </div>
    <label className="rail-search">
      <Search size={15} aria-hidden="true" />
      <input type="search" aria-label="Search threads" placeholder="Search threads" value={search} onChange={(event) => setSearch(event.target.value)} />
    </label>
    {archived && <p className="rail-archive-label">Archived</p>}
    <nav aria-label="Recent conversations">
      {matching.map((thread) => <div className="rail-thread-row" key={thread.id}>
        <button type="button" className="conversation-link" aria-current={activeId === thread.id ? "page" : undefined}
          title={thread.title} disabled={pending} onClick={() => open(thread.id)}>
          <MessageSquare size={16} aria-hidden="true" />
          <span className="conversation-link-copy">
            <span className="conversation-link-title">{thread.title}</span>
            {showNames && <small>{profiles.get(thread.personaId)?.displayName}</small>}
          </span>
        </button>
        <button type="button" className="icon-button thread-options" aria-haspopup="dialog" aria-label={"Manage " + thread.title}
          disabled={pending} onClick={(event) => manage(thread.id, event.currentTarget)}><Ellipsis size={16} aria-hidden="true" /></button>
      </div>)}
      {!matching.length && <p>{query ? "No matching threads." : archived ? "No archived conversations." : "New conversations appear here."}</p>}
    </nav>
  </section>;
}

export function ThreadSettings({ thread, pending, notice, close, change }: {
  thread: Conversation; pending: boolean; notice: string; close: () => void; change: (input: ConversationChange) => Promise<boolean>;
}) {
  const [title, setTitle] = useState(thread.title);
  const archived = thread.archivedAt !== undefined;
  return <DeveloperDrawer title="Manage conversation" closeLabel="Close conversation settings" close={close} icon={<Pencil size={17} />}>
    <form className="thread-settings" onSubmit={async (event) => {
      event.preventDefault();
      if (title.trim() && await change({ operation: "rename", title })) close();
    }}>
      <label>Conversation title<input value={title} maxLength={80} required onChange={(event) => setTitle(event.target.value)} /></label>
      <div className="thread-settings-actions">
        <button className="secondary-button" type="submit" disabled={pending || !title.trim() || title.trim() === thread.title}>Rename</button>
        <button className="secondary-button" type="button" disabled={pending}
          onClick={async () => { if (await change({ operation: archived ? "restore" : "archive" })) close(); }}>
          {archived ? "Restore conversation" : "Archive conversation"}
        </button>
      </div>
    </form>
    {notice && <p className="request-notice" role="alert">{notice}</p>}
  </DeveloperDrawer>;
}
