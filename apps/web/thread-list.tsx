import { useId, useState, type DragEvent } from "react";
import {
  Archive, Check, ChevronDown, ChevronRight, Ellipsis, Folder, FolderOpen, FolderPlus,
  MessageSquare, Pencil, Plus, Search, Trash2, X,
} from "lucide-react";
import type { Conversation, ConversationChange, ConversationFolder, DemoPersona } from "../../packages/contracts/api";
import { DeveloperDrawer } from "./developer-drawer";

const COLLAPSED_STORAGE_KEY = "cep_collapsed_folders";
const UNFILED_TARGET = "__unfiled__";

function loadCollapsed(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(COLLAPSED_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as Record<string, boolean> : {};
  } catch {
    return {};
  }
}

function saveCollapsed(map: Record<string, boolean>) {
  try {
    localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify(map));
  } catch { /* ignore storage errors */ }
}

export function ThreadList({
  threads, folders, profiles, activeId, showNames, pending, open, manage,
  onCreateFolder, onRenameFolder, onDeleteFolder, onMoveThread, onNewInFolder,
}: {
  threads: Conversation[];
  folders: ConversationFolder[];
  profiles: Map<string, DemoPersona>;
  activeId?: string;
  showNames: boolean;
  pending: boolean;
  open: (id: string) => void;
  manage: (id: string, trigger: HTMLButtonElement) => void;
  onCreateFolder: (name: string) => Promise<ConversationFolder | null>;
  onRenameFolder: (id: string, name: string) => Promise<boolean>;
  onDeleteFolder: (id: string) => Promise<boolean>;
  onMoveThread: (threadId: string, folderId: string | null) => Promise<boolean>;
  onNewInFolder: (folderId: string) => void;
}) {
  const heading = useId();
  const [search, setSearch] = useState("");
  const [archived, setArchived] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(loadCollapsed);
  const [dragThreadId, setDragThreadId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const query = search.trim().toLowerCase();
  const matching = threads.filter((thread) => (thread.archivedAt !== undefined) === archived
    && thread.title.toLowerCase().includes(query));

  const folderIds = new Set(folders.map((f) => f.id));

  const toggleFolder = (id: string) => {
    setCollapsed((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      saveCollapsed(next);
      return next;
    });
  };

  const expandFolder = (id: string) => {
    setCollapsed((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev, [id]: false };
      saveCollapsed(next);
      return next;
    });
  };

  const submitNewFolder = async () => {
    const clean = newFolderName.trim();
    if (!clean) return;
    const created = await onCreateFolder(clean);
    if (created) {
      expandFolder(created.id);
      setNewFolderName("");
      setCreatingFolder(false);
    }
  };

  const submitRename = async (id: string) => {
    const clean = renameValue.trim();
    if (!clean) {
      setRenamingId(null);
      return;
    }
    const ok = await onRenameFolder(id, clean);
    if (ok) setRenamingId(null);
  };

  const handleDragStart = (event: DragEvent<HTMLDivElement>, threadId: string) => {
    event.dataTransfer.setData("text/plain", threadId);
    event.dataTransfer.effectAllowed = "move";
    setDragThreadId(threadId);
  };

  const handleDragEnd = () => {
    setDragThreadId(null);
    setDropTarget(null);
  };

  const handleDragOver = (event: DragEvent, target: string) => {
    if (!dragThreadId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (dropTarget !== target) setDropTarget(target);
  };

  const handleDrop = async (event: DragEvent, folderId: string | null) => {
    event.preventDefault();
    const threadId = dragThreadId || event.dataTransfer.getData("text/plain");
    setDragThreadId(null);
    setDropTarget(null);
    if (!threadId) return;
    const current = threads.find((t) => t.id === threadId);
    if (!current || (current.folderId ?? null) === folderId) return;
    if (folderId) expandFolder(folderId);
    await onMoveThread(threadId, folderId);
  };

  const renderThreadRow = (thread: Conversation) => (
    <div
      className={
        "rail-thread-row"
        + (activeId === thread.id ? " rail-thread-active" : "")
        + (dragThreadId === thread.id ? " rail-thread-dragging" : "")
      }
      key={thread.id}
      draggable={!pending && !archived}
      onDragStart={(event) => handleDragStart(event, thread.id)}
      onDragEnd={handleDragEnd}
    >
      <button type="button" className="conversation-link" aria-current={activeId === thread.id ? "page" : undefined}
        title={thread.title} disabled={pending} onClick={() => open(thread.id)}>
        <MessageSquare size={15} aria-hidden="true" />
        <span className="conversation-link-copy">
          <span className="conversation-link-title">{thread.title}</span>
          {showNames && <small>{profiles.get(thread.personaId)?.displayName}</small>}
        </span>
      </button>
      <button type="button" className="icon-button thread-options" aria-haspopup="dialog" aria-label={"Manage " + thread.title}
        disabled={pending} onClick={(event) => manage(thread.id, event.currentTarget)}><Ellipsis size={16} aria-hidden="true" /></button>
    </div>
  );

  const threadsByFolder = new Map<string, Conversation[]>();
  const unfiled: Conversation[] = [];
  if (!archived) {
    for (const thread of matching) {
      if (thread.folderId && folderIds.has(thread.folderId)) {
        const list = threadsByFolder.get(thread.folderId);
        if (list) list.push(thread);
        else threadsByFolder.set(thread.folderId, [thread]);
      } else {
        unfiled.push(thread);
      }
    }
  }

  const visibleFolders = archived
    ? []
    : folders.filter((folder) => !query || folder.name.toLowerCase().includes(query) || (threadsByFolder.get(folder.id)?.length ?? 0) > 0);

  return <section className="rail-section rail-threads" aria-labelledby={heading}>
    <div className="rail-thread-heading">
      <h2 id={heading}>Chat threads</h2>
      <div className="rail-thread-heading-actions">
        {!archived && (
          <button
            className="archive-toggle icon-button"
            type="button"
            aria-label="New folder"
            aria-pressed={creatingFolder}
            title="New folder"
            disabled={pending}
            onClick={() => {
              setCreatingFolder((openForm) => !openForm);
              setNewFolderName("");
            }}
          >
            <FolderPlus size={15} aria-hidden="true" />
          </button>
        )}
        <button className="archive-toggle icon-button" type="button" aria-label="Archived conversations"
          aria-pressed={archived} title={archived ? "Show active conversations" : "Show archived conversations"}
          onClick={() => { setArchived(!archived); setCreatingFolder(false); }}><Archive size={15} aria-hidden="true" /></button>
      </div>
    </div>
    <label className="rail-search">
      <Search size={15} aria-hidden="true" />
      <input type="search" aria-label="Search threads" placeholder="Search threads" value={search} onChange={(event) => setSearch(event.target.value)} />
    </label>
    {creatingFolder && !archived && (
      <form
        className="rail-folder-create"
        onSubmit={(event) => {
          event.preventDefault();
          void submitNewFolder();
        }}
      >
        <input
          type="text"
          aria-label="New folder name"
          placeholder="Folder name (e.g. Taxes, Home)"
          maxLength={48}
          autoFocus
          value={newFolderName}
          disabled={pending}
          onChange={(event) => setNewFolderName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setCreatingFolder(false);
              setNewFolderName("");
            }
          }}
        />
        <button type="submit" className="icon-button" aria-label="Create folder" title="Create folder" disabled={pending || !newFolderName.trim()}>
          <Check size={14} aria-hidden="true" />
        </button>
        <button type="button" className="icon-button" aria-label="Cancel" title="Cancel" onClick={() => { setCreatingFolder(false); setNewFolderName(""); }}>
          <X size={14} aria-hidden="true" />
        </button>
      </form>
    )}
    {archived && <p className="rail-archive-label">Archived</p>}
    <nav aria-label="Recent conversations">
      {archived ? (
        <>
          {matching.map(renderThreadRow)}
          {!matching.length && <p>{query ? "No matching threads." : "No archived conversations."}</p>}
        </>
      ) : folders.length === 0 ? (
        <>
          {matching.map(renderThreadRow)}
          {!matching.length && <p>{query ? "No matching threads." : "New conversations appear here."}</p>}
        </>
      ) : (
        <>
          {visibleFolders.map((folder) => {
            const items = threadsByFolder.get(folder.id) ?? [];
            const isOpen = Boolean(query) || !collapsed[folder.id];
            const isRenaming = renamingId === folder.id;
            const isDropTarget = dropTarget === folder.id;
            return (
              <div
                key={folder.id}
                className={"rail-folder" + (isDropTarget ? " rail-folder-drop-active" : "")}
                onDragOver={(event) => handleDragOver(event, folder.id)}
                onDragLeave={() => { if (dropTarget === folder.id) setDropTarget(null); }}
                onDrop={(event) => void handleDrop(event, folder.id)}
              >
                {isRenaming ? (
                  <form
                    className="rail-folder-rename"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void submitRename(folder.id);
                    }}
                  >
                    <input
                      type="text"
                      aria-label="Rename folder"
                      maxLength={48}
                      autoFocus
                      value={renameValue}
                      disabled={pending}
                      onChange={(event) => setRenameValue(event.target.value)}
                      onKeyDown={(event) => { if (event.key === "Escape") setRenamingId(null); }}
                    />
                    <button type="submit" className="icon-button" aria-label="Save folder name" disabled={pending || !renameValue.trim()}>
                      <Check size={13} aria-hidden="true" />
                    </button>
                    <button type="button" className="icon-button" aria-label="Cancel rename" onClick={() => setRenamingId(null)}>
                      <X size={13} aria-hidden="true" />
                    </button>
                  </form>
                ) : (
                  <div className="rail-folder-head">
                    <button
                      type="button"
                      className="rail-folder-toggle"
                      aria-expanded={isOpen}
                      onClick={() => toggleFolder(folder.id)}
                    >
                      {isOpen ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
                      {isOpen ? <FolderOpen size={14} aria-hidden="true" /> : <Folder size={14} aria-hidden="true" />}
                      <span className="rail-folder-name">{folder.name}</span>
                      <span className="rail-folder-count">{items.length}</span>
                    </button>
                    <div className="rail-folder-actions">
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={"New conversation in " + folder.name}
                        title={"New conversation in " + folder.name}
                        disabled={pending}
                        onClick={() => {
                          expandFolder(folder.id);
                          onNewInFolder(folder.id);
                        }}
                      >
                        <Plus size={13} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={"Rename folder " + folder.name}
                        title="Rename folder"
                        disabled={pending}
                        onClick={() => {
                          setRenamingId(folder.id);
                          setRenameValue(folder.name);
                        }}
                      >
                        <Pencil size={12} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={"Delete folder " + folder.name}
                        title="Delete folder (keeps chats)"
                        disabled={pending}
                        onClick={() => void onDeleteFolder(folder.id)}
                      >
                        <Trash2 size={12} aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                )}
                {isOpen && (
                  <div className="rail-folder-threads">
                    {items.map(renderThreadRow)}
                    {!items.length && !query && (
                      <p className="rail-folder-empty">Drop a chat here or click +</p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          <div
            className={"rail-unfiled-group" + (dropTarget === UNFILED_TARGET ? " rail-folder-drop-active" : "")}
            onDragOver={(event) => handleDragOver(event, UNFILED_TARGET)}
            onDragLeave={() => { if (dropTarget === UNFILED_TARGET) setDropTarget(null); }}
            onDrop={(event) => void handleDrop(event, null)}
          >
            {(unfiled.length > 0 || dragThreadId) && (
              <p className="rail-unfiled-label">{dragThreadId ? "Drop here to remove from folder" : "Unfiled"}</p>
            )}
            {unfiled.map(renderThreadRow)}
          </div>
          {!matching.length && !visibleFolders.length && <p>{query ? "No matching threads." : "New conversations appear here."}</p>}
        </>
      )}
    </nav>
  </section>;
}

export function ThreadSettings({ thread, folders, pending, notice, close, change }: {
  thread: Conversation;
  folders: ConversationFolder[];
  pending: boolean;
  notice: string;
  close: () => void;
  change: (input: ConversationChange) => Promise<boolean>;
}) {
  const [title, setTitle] = useState(thread.title);
  const [folderId, setFolderId] = useState(thread.folderId ?? "");
  const archived = thread.archivedAt !== undefined;
  return <DeveloperDrawer title="Manage conversation" closeLabel="Close conversation settings" close={close} icon={<Pencil size={17} />}>
    <form className="thread-settings" onSubmit={async (event) => {
      event.preventDefault();
      if (title.trim() && await change({ operation: "rename", title })) close();
    }}>
      <label>Conversation title<input value={title} maxLength={80} required onChange={(event) => setTitle(event.target.value)} /></label>
      <label>
        Folder
        <select
          aria-label="Conversation folder"
          value={folderId}
          disabled={pending}
          onChange={async (event) => {
            const next = event.target.value;
            setFolderId(next);
            await change({ operation: "move", folderId: next || null });
          }}
        >
          <option value="">No folder (Unfiled)</option>
          {folders.map((folder) => (
            <option key={folder.id} value={folder.id}>{folder.name}</option>
          ))}
        </select>
      </label>
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
