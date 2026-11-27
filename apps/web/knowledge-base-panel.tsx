import { useEffect, useState } from "react";
import { BookOpen, Plus, RotateCcw, Save, Search, Trash2, Upload } from "lucide-react";
import type { KnowledgeDocument, KnowledgeDocumentUpsertInput, KnowledgeSearchResult } from "../../packages/contracts/knowledge-base";
import { api, isPublicationReview } from "./api";

function makeBlankDoc(): KnowledgeDocumentUpsertInput {
  return {
    id: `policy_${Date.now().toString(36).slice(-4)}`,
    title: "New Enterprise Policy Document",
    domain: "wealth",
    version: "1.0",
    tags: ["policy", "compliance"],
    content: "Section 1 — Policy Overview: Describe your compliance rule, approval threshold, or operational procedure here.\n\nSection 2 — Escalation & Audit: Specify when Human-in-the-Loop (HITL) approval is required.",
    enabled: true,
  };
}

export function KnowledgeBasePanel() {
  const [docs, setDocs] = useState<(KnowledgeDocument & { chunkCount: number })[]>([]);
  const [totalChunks, setTotalChunks] = useState(0);
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<KnowledgeDocumentUpsertInput | null>(null);
  const [query, setQuery] = useState("What is our wire transfer compliance threshold and cutoff?");
  const [searchResult, setSearchResult] = useState<KnowledgeSearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const load = async (keepId?: string) => {
    try {
      const view = await api.knowledgeBase();
      setDocs(view.documents);
      setTotalChunks(view.totalChunks);
      const target = (keepId && view.documents.find((d) => d.id === keepId)) ?? view.documents[0];
      if (target) pickDoc(target);
    } catch (err: unknown) {
      setNotice({ tone: "error", text: err instanceof Error ? err.message : "Could not load Knowledge Base." });
    }
  };

  useEffect(() => { void load(); }, []);

  const pickDoc = (doc: KnowledgeDocument) => {
    setSelectedId(doc.id);
    setDraft({
      id: doc.id,
      title: doc.title,
      domain: doc.domain,
      version: doc.version,
      tags: [...doc.tags],
      content: doc.content,
      enabled: doc.enabled,
    });
    setNotice(null);
  };

  const handleFileUpload = async (file: File | undefined) => {
    if (!file) return;
    const raw = (await file.text()).replace(/\r\n/g, "\n").trim();
    if (raw.length < 20) {
      setNotice({ tone: "error", text: "Uploaded file must contain at least 20 characters of policy text." });
      return;
    }
    const baseName = file.name.replace(/\.[^.]+$/, "");
    const id = baseName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 42) || `policy_${Date.now().toString(36).slice(-4)}`;
    setSelectedId(id);
    setDraft({
      id,
      title: baseName.replace(/[_-]+/g, " "),
      domain: "wealth",
      version: "1.0",
      tags: ["uploaded", "policy"],
      content: raw.slice(0, 12_000),
      enabled: true,
    });
    setNotice({ tone: "ok", text: `Loaded "${file.name}" (${raw.length} chars). Click Save & Index Document to publish to Policy RAG.` });
  };

  const saveDoc = async () => {
    if (!draft) return;
    setBusy(true);
    setNotice(null);
    try {
      const view = await api.saveKnowledgeDoc(draft);
      if (isPublicationReview(view)) return;
      setDocs(view.documents);
      setTotalChunks(view.totalChunks);
      const saved = view.documents.find((d) => d.id === draft.id);
      if (saved) pickDoc(saved);
      setNotice({ tone: "ok", text: `Indexed "${draft.title}" (${view.totalChunks} total searchable clauses across ${view.documents.length} documents).` });
    } catch (err: unknown) {
      setNotice({ tone: "error", text: err instanceof Error ? err.message : "Could not save policy document." });
    } finally {
      setBusy(false);
    }
  };

  const deleteOrReset = async () => {
    if (!draft) return;
    setBusy(true);
    setNotice(null);
    try {
      const view = await api.deleteKnowledgeDoc(draft.id);
      if (isPublicationReview(view)) return;
      setDocs(view.documents);
      setTotalChunks(view.totalChunks);
      const next = view.documents.find((d) => d.id === draft.id) ?? view.documents[0];
      if (next) pickDoc(next);
      setNotice({ tone: "ok", text: `Updated policy document "${draft.id}".` });
    } catch (err: unknown) {
      setNotice({ tone: "error", text: err instanceof Error ? err.message : "Could not delete or reset document." });
    } finally {
      setBusy(false);
    }
  };

  const testSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    setBusy(true);
    try {
      const res = await api.searchKnowledgeBase(query.trim());
      setSearchResult(res);
    } catch (err: unknown) {
      setNotice({ tone: "error", text: err instanceof Error ? err.message : "RAG retrieval failed." });
    } finally {
      setBusy(false);
    }
  };

  const selectedDoc = docs.find((d) => d.id === selectedId);

  return (
    <div className="wf-studio-layout">
      <aside className="reg-rail wf-rail">
        <div className="reg-rail-head">
          <h2>Policy Docs ({docs.length} · {totalChunks} §)</h2>
          <button
            type="button"
            className="reg-mini-btn"
            onClick={() => {
              const blank = makeBlankDoc();
              setSelectedId(blank.id);
              setDraft(blank);
              setNotice(null);
            }}
          >
            <Plus size={14} aria-hidden="true" />New
          </button>
        </div>

        <label className="kb-upload-drop">
          <Upload size={14} aria-hidden="true" />
          <span>Upload .txt / .md / .csv Policy File</span>
          <input
            type="file"
            accept=".txt,.md,.csv,.json"
            style={{ display: "none" }}
            onChange={(e) => {
              void handleFileUpload(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </label>

        <div className="reg-list">
          {docs.map((doc) => (
            <button
              key={doc.id}
              type="button"
              className={"reg-list-item" + (selectedId === doc.id ? " is-active" : "")}
              onClick={() => pickDoc(doc)}
            >
              <div className="reg-item-top">
                <strong>{doc.title}</strong>
                <span className="reg-tag">v{doc.version}</span>
              </div>
              <span className="reg-item-sub">{doc.domain} · {doc.chunkCount} clauses</span>
            </button>
          ))}
        </div>
      </aside>

      <section className="reg-editor wf-editor">
        <form className="wf-copilot-bar" onSubmit={testSearch}>
          <div className="wf-copilot-head">
            <strong><Search size={15} aria-hidden="true" /> Live Policy RAG Retrieval Test</strong>
            <span className="reg-tag">{totalChunks} indexed clauses</span>
          </div>
          <div className="wf-copilot-form">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Ask a policy question, e.g. What is the enterprise discount approval cap?"
            />
            <button type="submit" className="reg-save-btn" disabled={busy || query.trim().length < 2}>
              <Search size={14} aria-hidden="true" />Test Retrieval
            </button>
          </div>
          {searchResult && (
            <div className="kb-search-results">
              {searchResult.citations.length === 0 ? (
                <p className="wf-muted-note">No matching policy clauses found for that query.</p>
              ) : (
                searchResult.citations.map((c) => (
                  <div key={`${c.docId}-${c.chunkIndex}`} className="kb-citation-row">
                    <div className="kb-citation-top">
                      <strong><BookOpen size={13} aria-hidden="true" /> {c.docTitle}</strong>
                      <span className="reg-tag">v{c.version} · §{c.chunkIndex} · {c.score}% match</span>
                    </div>
                    <p>{c.excerpt}</p>
                  </div>
                ))
              )}
            </div>
          )}
        </form>

        {notice && <p className={"reg-notice " + (notice.tone === "error" ? "is-error" : "is-ok")} role="status">{notice.text}</p>}

        {draft && (
          <>
            <div className="wf-editor-head">
              <div>
                <h2>{draft.title}</h2>
                <p className="wf-editor-sub">
                  Indexed by paragraph into <code>knowledge-base.json</code>. Policy questions in Chat &amp; Embed SDK automatically cite verified clauses from here.
                </p>
              </div>
              <div className="wf-editor-actions">
                <button type="button" className="reg-save-btn" disabled={busy} onClick={saveDoc}>
                  <Save size={14} aria-hidden="true" />Save &amp; Index Document
                </button>
                {selectedDoc && (
                  <button type="button" className="reg-mini-btn" disabled={busy} onClick={deleteOrReset}>
                    {selectedDoc.isBuiltIn ? <><RotateCcw size={14} aria-hidden="true" />Reset</> : <><Trash2 size={14} aria-hidden="true" />Delete</>}
                  </button>
                )}
              </div>
            </div>

            <div className="wf-meta-grid">
              <label>
                <span>Document ID</span>
                <input value={draft.id} onChange={(e) => setDraft({ ...draft, id: e.target.value })} />
              </label>
              <label>
                <span>Title</span>
                <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
              </label>
              <label>
                <span>Domain</span>
                <select value={draft.domain} onChange={(e) => setDraft({ ...draft, domain: e.target.value as KnowledgeDocument["domain"] })}>
                  <option value="wealth">Wealth</option>
                  <option value="operations">Operations / SRE</option>
                  <option value="sales">Sales / RevOps</option>
                  <option value="general">General</option>
                </select>
              </label>
              <label>
                <span>Version</span>
                <input value={draft.version ?? "1.0"} onChange={(e) => setDraft({ ...draft, version: e.target.value })} />
              </label>
            </div>

            <label className="wf-wide-field">
              <span>Tags (comma-separated)</span>
              <input
                value={(draft.tags ?? []).join(", ")}
                onChange={(e) => setDraft({ ...draft, tags: e.target.value.split(",").map((t) => t.trim()).filter(Boolean) })}
              />
            </label>

            <label className="wf-wide-field">
              <span>Policy Clauses (separate sections with blank lines for granular chunk citations)</span>
              <textarea
                className="kb-content-editor"
                rows={12}
                value={draft.content}
                onChange={(e) => setDraft({ ...draft, content: e.target.value })}
              />
            </label>
          </>
        )}
      </section>
    </div>
  );
}
