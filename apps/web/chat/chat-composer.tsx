/**
 * Interactive chat composer with slash commands, voice dictation, file/sample attachments,
 * and hero vs dock layout variants. Extracted from `apps/web/main.tsx`.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useAui } from "@assistant-ui/react";
import { Mic, MicOff, Paperclip, Play, Square } from "lucide-react";
import { MAX_MESSAGE_LENGTH } from "../../../packages/contracts/domain";
import type { DomainPack } from "../../../packages/contracts/domain-packs";
import { matchSlashCommands, SlashCommandMenu, type SlashCommand } from "../chat-rich-ux";
import {
  AttachmentChipList, composeMessageWithAttachments, createSampleAttachment,
  NextSuggestionChips, readAttachmentFile, SAMPLE_UPLOAD_DOCUMENTS, useVoiceInput,
  type ComposerAttachment, type NextSuggestion,
} from "../composer-extras";
import { StarterPrompts } from "./chat-messages";

export interface ComposerProps {
  draft: string;
  onDraft: (value: string) => void;
  running: boolean;
  pending: boolean;
  disabled: boolean;
  adminChat: boolean;
  notice: string;
  input: React.RefObject<HTMLTextAreaElement | null>;
  showStarters: boolean;
  hero?: boolean;
  nextSuggestions: NextSuggestion[];
  domainPack?: DomainPack;
  onOpenAdvisor?: () => void;
  onOpenMemory?: () => void;
  onOpenFutures?: () => void;
  onOpenWatch?: () => void;
  onOpenDelegate?: () => void;
}

export function Composer({
  draft, onDraft, running, pending, disabled, adminChat, notice, input, showStarters, hero,
  nextSuggestions, domainPack, onOpenAdvisor, onOpenMemory, onOpenFutures, onOpenWatch, onOpenDelegate,
}: ComposerProps) {
  const aui = useAui();
  const fileInput = useRef<HTMLInputElement>(null);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [localNotice, setLocalNotice] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [sampleMenuOpen, setSampleMenuOpen] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const slashCommands = useMemo(() => matchSlashCommands(draft), [draft]);
  useEffect(() => { setSlashIndex(0); }, [slashCommands.length, draft]);

  const runSlashCommand = (cmd: SlashCommand) => {
    onDraft("");
    if (cmd.action === "prompt" && cmd.prompt) {
      aui.thread().append(cmd.prompt);
    } else if (cmd.action === "advisor") {
      onOpenAdvisor?.();
    } else if (cmd.action === "memory") {
      onOpenMemory?.();
    } else if (cmd.action === "futures") {
      onOpenFutures?.();
    } else if (cmd.action === "watch") {
      onOpenWatch?.();
    } else if (cmd.action === "delegate") {
      onOpenDelegate?.();
    } else if (cmd.action === "upload") {
      fileInput.current?.click();
    }
  };

  const voice = useVoiceInput({
    onTranscript: (text) => {
      setLocalNotice("");
      onDraft(text);
    },
    onError: (msg) => setLocalNotice(msg),
  });

  useEffect(() => () => {
    for (const item of attachments) {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    }
  }, [attachments]);

  const addFiles = async (fileList: FileList | null) => {
    if (!fileList?.length) return;
    setLocalNotice("");
    const incoming = Array.from(fileList).slice(0, Math.max(0, 4 - attachments.length));
    if (!incoming.length) {
      setLocalNotice("You can attach up to 4 files per message.");
      return;
    }
    const parsed = await Promise.all(incoming.map((file) => readAttachmentFile(file)));
    setAttachments((prev) => [...prev, ...parsed]);
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => {
      const target = prev.find((item) => item.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((item) => item.id !== id);
    });
  };

  const canSubmit = !pending && !disabled && (Boolean(draft.trim()) || attachments.length > 0);
  const send = () => {
    if (!canSubmit) return;
    if (voice.listening) voice.stop();
    const payload = composeMessageWithAttachments(draft, attachments);
    setAttachments([]);
    setLocalNotice("");
    aui.thread().append(payload);
  };

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (slashCommands.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSlashIndex((i) => (i + 1) % slashCommands.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSlashIndex((i) => (i - 1 + slashCommands.length) % slashCommands.length);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        onDraft("");
        return;
      }
      if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault();
        const picked = slashCommands[slashIndex] ?? slashCommands[0];
        if (picked) runSlashCommand(picked);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  }
  const nearLimit = draft.length > MAX_MESSAGE_LENGTH * 0.8;
  const activeNotice = notice || localNotice;

  return <div className={hero ? "composer-area composer-hero" : "composer-area composer-dock"}>
    <div className="composer-inner">
      {!hero && showStarters && <StarterPrompts disabled={disabled || pending} adminChat={adminChat} />}
      {!hero && !showStarters && !running && (
        <NextSuggestionChips
          suggestions={nextSuggestions}
          disabled={disabled || pending}
          onPick={(prompt) => aui.thread().append(prompt)}
        />
      )}
      {activeNotice && <div className="request-notice" role="status">{activeNotice}</div>}
      {running && !pending && !activeNotice && (
        <div className="submit-status" role="status">
          Task running in this thread — you can send your next question anytime.
          {canSubmit && (
            <button type="button" className="inline-stop-link" onClick={() => aui.thread().cancelRun()}>
              End running task
            </button>
          )}
        </div>
      )}
      {pending && !running && !activeNotice && <div className="submit-status" role="status">Sending your request…</div>}
      <div className="composer-slash-wrap">
      <SlashCommandMenu commands={slashCommands} activeIndex={slashIndex} onPick={runSlashCommand} />
      <form
        className={"composer" + (dragOver ? " is-drag-over" : "") + (attachments.length ? " has-attachments" : "")}
        onSubmit={(event) => { event.preventDefault(); send(); }}
        onDragOver={(event) => { event.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragOver(false);
          void addFiles(event.dataTransfer.files);
        }}
      >
        <AttachmentChipList attachments={attachments} onRemove={removeAttachment} />
        <div className="composer-input-row">
          <div className="composer-field">
            <label className="sr-only" htmlFor="composer-input">Your question</label>
            <textarea id="composer-input" ref={input} rows={1} value={draft} maxLength={MAX_MESSAGE_LENGTH}
              placeholder={voice.listening ? "Listening… speak your question" : (domainPack?.composerPlaceholder ?? "Ask a question…")}
              onChange={(event) => onDraft(event.target.value)} onKeyDown={onKeyDown} />
          </div>
          <div className="composer-tools">
            <input
              ref={fileInput}
              type="file"
              multiple
              className="sr-only"
              accept=".pdf,.csv,.txt,.json,.md,.log,.png,.jpg,.jpeg,.webp"
              onChange={(event) => {
                void addFiles(event.target.files);
                event.target.value = "";
              }}
            />
            <div className="composer-attach-wrap">
              <button
                type="button"
                className="composer-tool-btn"
                aria-label="Attach file"
                title="Attach invoice, CSV, log, PDF, or pick a sample document"
                disabled={disabled || pending}
                onClick={() => setSampleMenuOpen((open) => !open)}
              >
                <Paperclip size={16} aria-hidden="true" />
              </button>
              {sampleMenuOpen && (
                <div className="composer-sample-menu" role="menu" aria-label="Document to Action upload">
                  <button
                    type="button"
                    className="composer-sample-item is-primary"
                    onClick={() => {
                      setSampleMenuOpen(false);
                      fileInput.current?.click();
                    }}
                  >
                    Upload file from computer…
                  </button>
                  <div className="composer-sample-divider">Or attach sample document:</div>
                  {SAMPLE_UPLOAD_DOCUMENTS.map((doc) => (
                    <button
                      key={doc.id}
                      type="button"
                      className="composer-sample-item"
                      onClick={() => {
                        const att = createSampleAttachment(doc.id);
                        if (att) setAttachments((prev) => [...prev.slice(0, 3), att]);
                        setSampleMenuOpen(false);
                      }}
                    >
                      {doc.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              type="button"
              className={"composer-tool-btn" + (voice.listening ? " is-listening" : "")}
              aria-label={voice.listening ? "Stop voice input" : "Voice input"}
              aria-pressed={voice.listening}
              title={voice.listening ? "Stop voice dictation" : "Dictate with microphone"}
              disabled={disabled || pending}
              onClick={() => voice.toggle(draft)}
            >
              {voice.listening ? <MicOff size={16} aria-hidden="true" /> : <Mic size={16} aria-hidden="true" />}
            </button>
            {running && !canSubmit ? (
              <button
                className="send-button stop-button"
                type="button"
                disabled={pending}
                aria-label="End running task"
                title="End running task"
                onClick={() => aui.thread().cancelRun()}
              >
                <Square size={12} fill="currentColor" aria-hidden="true" />
              </button>
            ) : (
              <button
                className="send-button play-button"
                type="submit"
                disabled={!canSubmit}
                aria-label="Send message"
                title="Send message"
              >
                <Play size={14} fill="currentColor" aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      </form>
      </div>
      <div className="composer-footer-row">
        <span className="composer-guardrail">
          {voice.listening
            ? <span className="voice-live-badge"><span aria-hidden="true" />Listening via microphone…</span>
            : (adminChat ? "Admin test environment" : null)}
        </span>
        <div className="composer-footer-right">
          {nearLimit && <span className="composer-count">{draft.length}/{MAX_MESSAGE_LENGTH}</span>}
          <p className="composer-hint">Type / for commands <span aria-hidden="true">·</span> Enter to send <span aria-hidden="true">·</span> Shift+Enter for a new line</p>
        </div>
      </div>
      {hero && showStarters && <StarterPrompts disabled={disabled || pending} adminChat={adminChat} />}
    </div>
  </div>;
}
