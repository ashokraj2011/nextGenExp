import { useCallback, useEffect, useRef, useState } from "react";
import { FileSpreadsheet, FileText, Image as ImageIcon, Sparkles, Volume2, VolumeX, X } from "lucide-react";
import type { DemoPersona, TurnView } from "../../packages/contracts/api";
import { MAX_MESSAGE_LENGTH } from "../../packages/contracts/domain";

export type ComposerAttachment = {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  kind: "text" | "image" | "document";
  excerpt?: string;
  previewUrl?: string;
};

export type NextSuggestion = {
  label: string;
  prompt: string;
};

const TEXT_EXTENSIONS = /\.(txt|csv|json|md|tsv|log)$/i;
const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|gif)$/i;

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const SAMPLE_UPLOAD_DOCUMENTS: { id: string; label: string; name: string; content: string }[] = [
  {
    id: "wire_invoice",
    label: "Wire Invoice ($18,500)",
    name: "wire-invoice-18500.txt",
    content: "INVOICE #INV-2026-441\nRecipient: Horizon Real Estate Escrow LLC\nWire Amount: $18,500\nRail: Domestic Fedwire\nMemo: Closing earnest deposit",
  },
  {
    id: "trade_csv",
    label: "Equity Order CSV (AAPL)",
    name: "equity-rebalance-order.csv",
    content: "symbol,side,percent,notes\nAAPL,sell,40,Rebalance tech overweight and analyze tax-loss harvesting",
  },
  {
    id: "outage_log",
    label: "P1 Outage Log (5xx)",
    name: "checkout-api-outage.log",
    content: "ALERT P1 service: checkout-api release: v4.12.1\n5xx error_rate: 4.9% p95 latency: 448ms\nERROR UpstreamPoolExhausted after v4.12.1 canary promotion",
  },
];

export function createSampleAttachment(sampleId: string): ComposerAttachment | null {
  const found = SAMPLE_UPLOAD_DOCUMENTS.find((s) => s.id === sampleId);
  if (!found) return null;
  return {
    id: crypto.randomUUID(),
    name: found.name,
    size: found.content.length,
    mimeType: "text/plain",
    kind: "text",
    excerpt: found.content,
  };
}

export async function readAttachmentFile(file: File): Promise<ComposerAttachment> {
  const id = crypto.randomUUID();
  const isImage = file.type.startsWith("image/") || IMAGE_EXTENSIONS.test(file.name);
  const isText = file.type.startsWith("text/") || file.type === "application/json" || TEXT_EXTENSIONS.test(file.name);

  if (isImage) {
    const previewUrl = URL.createObjectURL(file);
    return { id, name: file.name, size: file.size, mimeType: file.type || "image/*", kind: "image", previewUrl };
  }

  if (isText) {
    const raw = await file.text();
    const cleaned = raw.replace(/\r\n/g, "\n").trim();
    const excerpt = cleaned.length > 650 ? cleaned.slice(0, 650) + "…" : cleaned;
    return { id, name: file.name, size: file.size, mimeType: file.type || "text/plain", kind: "text", excerpt };
  }

  return { id, name: file.name, size: file.size, mimeType: file.type || "application/octet-stream", kind: "document" };
}

export function composeMessageWithAttachments(draft: string, attachments: ComposerAttachment[]): string {
  const trimmed = draft.trim();
  if (!attachments.length) return trimmed;

  const base = trimmed || `Please review the attached ${attachments.length === 1 ? "file" : "files"} (${attachments.map((a) => a.name).join(", ")}).`;
  const lines = attachments.map((att) => {
    const header = `[Attached: ${att.name} (${formatBytes(att.size)})]`;
    return att.excerpt ? `${header}\n${att.excerpt}` : header;
  });
  const combined = `${base}\n\n${lines.join("\n\n")}`;
  return combined.length <= MAX_MESSAGE_LENGTH ? combined : combined.slice(0, MAX_MESSAGE_LENGTH - 1) + "…";
}

export function AttachmentChipList({ attachments, onRemove }: {
  attachments: ComposerAttachment[];
  onRemove: (id: string) => void;
}) {
  if (!attachments.length) return null;
  return (
    <div className="composer-attachments" role="list" aria-label="Attached files">
      {attachments.map((item) => {
        const Icon = item.kind === "image" ? ImageIcon : item.name.endsWith(".csv") ? FileSpreadsheet : FileText;
        return (
          <div key={item.id} className="attachment-chip" role="listitem">
            {item.previewUrl
              ? <img src={item.previewUrl} alt="" className="attachment-thumb" />
              : <Icon size={14} className="attachment-icon" aria-hidden="true" />}
            <span className="attachment-name" title={item.name}>{item.name}</span>
            <small className="attachment-size">{formatBytes(item.size)}</small>
            <button
              type="button"
              className="attachment-remove"
              aria-label={`Remove ${item.name}`}
              onClick={() => onRemove(item.id)}
            >
              <X size={13} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function computeNextSuggestions(
  latestTurn?: TurnView,
  activeProfile?: DemoPersona,
  intentPrompts?: { intentId: string; label: string; prompt: string; isCustom: boolean }[],
  fundingComplete = activeProfile?.profile?.accountFundingStatus === "funded",
): NextSuggestion[] {
  if (!latestTurn || latestTurn.status !== "completed") return [];
  const blocks = latestTurn.experience?.blocks.map((block) => block.component) ?? [];
  const lastUserMsg = latestTurn.message.toLowerCase();
  const candidates: NextSuggestion[] = [];

  // Prioritize newly created or customized intents from /admin/intents so they surface automatically
  for (const item of intentPrompts ?? []) {
    if (item.isCustom && item.prompt.trim()) {
      candidates.push({ label: item.label, prompt: item.prompt });
    }
  }

  const hasHomeGoal = Boolean(activeProfile?.overview?.homeGoal);

  if (blocks.includes("PznPortfolioSnapshot")) {
    if (hasHomeGoal) {
      candidates.push({
        label: "Model 2-year home plan",
        prompt: "I want to buy a house in two years. Show me how close I am and help me explore a savings plan.",
      });
    }
    candidates.push({ label: "Explore retirement basics", prompt: "I'd like to learn about retirement." });
  } else if (blocks.includes("PznGoalProgress") || blocks.includes("PznSavingsChart")) {
    candidates.push({
      label: "Check required monthly savings",
      prompt: "How much do I need to save each month to reach my house deposit target?",
    });
    candidates.push({ label: "Review portfolio mix", prompt: "Let me know my portfolio summary." });
    candidates.push({ label: "Explore retirement basics", prompt: "I'd like to learn about retirement." });
  } else if (blocks.includes("PznFundingOptions") || blocks.includes("PznFundingPreview")) {
    if (!fundingComplete) candidates.push({ label: "Change deposit to $750", prompt: "Change it to $750" });
    candidates.push({ label: "Check what's next for me", prompt: "What is next?" });
    candidates.push({ label: "Mailing address steps", prompt: "I need to update my mailing address." });
  } else if (blocks.includes("PznComparison") || blocks.includes("PznMetricSummary")) {
    candidates.push({ label: "Review portfolio mix", prompt: "Let me know my portfolio summary." });
    candidates.push({ label: "Walk through transfer steps", prompt: "Walk me through the transfer steps." });
    if (hasHomeGoal) {
      candidates.push({ label: "Check home-buying progress", prompt: "Show my home-buying goal and savings progress." });
    }
  } else {
    if (activeProfile?.overview?.portfolio) {
      candidates.push({ label: "Review portfolio mix", prompt: "Let me know my portfolio summary." });
    }
    if (hasHomeGoal) {
      candidates.push({
        label: "Model 2-year home plan",
        prompt: "I want to buy a house in two years. Show me how close I am and help me explore a savings plan.",
      });
    }
    candidates.push({ label: "Compare balance terms", prompt: "Compare available and current balance." });
  }

  const seenPrompts = new Set<string>();
  return candidates
    .filter((item) => {
      const promptKey = item.prompt.toLowerCase();
      if (promptKey === lastUserMsg || seenPrompts.has(promptKey)) {
        return false;
      }
      seenPrompts.add(promptKey);
      return true;
    })
    .slice(0, 3);
}

export function NextSuggestionChips({ suggestions, disabled, onPick }: {
  suggestions: NextSuggestion[];
  disabled: boolean;
  onPick: (prompt: string) => void;
}) {
  if (!suggestions.length) return null;
  return (
    <div className="next-suggestions-bar" role="group" aria-label="Suggested next questions">
      <span className="next-suggestions-label"><Sparkles size={11} aria-hidden="true" />Next</span>
      <div className="next-suggestions">
        {suggestions.map(({ label, prompt }) => (
          <button key={prompt} type="button" className="next-suggestion-pill" disabled={disabled} onClick={() => onPick(prompt)}>
            <span>{label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechCtor = new () => SpeechRecognitionLike;

export function useVoiceInput({ onTranscript, onError }: {
  onTranscript: (text: string) => void;
  onError: (message: string) => void;
}) {
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const callbacks = useRef({ onTranscript, onError });
  callbacks.current = { onTranscript, onError };

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setListening(false);
  }, []);

  const toggle = useCallback((existingDraft: string) => {
    if (listening) {
      stop();
      return;
    }
    const win = window as unknown as { SpeechRecognition?: SpeechCtor; webkitSpeechRecognition?: SpeechCtor };
    const Ctor = win.SpeechRecognition ?? win.webkitSpeechRecognition;
    if (!Ctor) {
      callbacks.current.onError("Voice dictation isn’t supported in this browser. Try Chrome or Safari.");
      return;
    }
    try {
      const recognition = new Ctor();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = navigator.language || "en-US";
      const prefix = existingDraft.trim() ? existingDraft.trim() + " " : "";
      let committed = "";

      recognition.onresult = (event) => {
        let interim = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const segment = event.results[i][0]?.transcript ?? "";
          if (event.results[i].isFinal) committed += segment;
          else interim += segment;
        }
        const combined = (prefix + committed + interim).slice(0, MAX_MESSAGE_LENGTH);
        callbacks.current.onTranscript(combined);
      };
      recognition.onerror = (event) => {
        if (event.error !== "no-speech" && event.error !== "aborted") {
          callbacks.current.onError(
            event.error === "not-allowed"
              ? "Microphone permission was denied. Allow mic access in your browser to use voice input."
              : "Voice input stopped unexpectedly. Please try again.",
          );
        }
        setListening(false);
      };
      recognition.onend = () => {
        recognitionRef.current = null;
        setListening(false);
      };

      recognitionRef.current = recognition;
      setListening(true);
      recognition.start();
    } catch {
      setListening(false);
      callbacks.current.onError("Couldn’t start microphone dictation.");
    }
  }, [listening, stop]);

  useEffect(() => () => { recognitionRef.current?.stop(); }, []);

  return { listening, toggle, stop };
}

export function SpeakButton({ text }: { text: string }) {
  const [speaking, setSpeaking] = useState(false);

  useEffect(() => () => {
    if (speaking && "speechSynthesis" in window) window.speechSynthesis.cancel();
  }, [speaking]);

  if (!text.trim() || typeof window === "undefined" || !("speechSynthesis" in window)) return null;

  const toggleSpeak = () => {
    if (speaking) {
      window.speechSynthesis.cancel();
      setSpeaking(false);
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text.replace(/[*`#]/g, ""));
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    setSpeaking(true);
    window.speechSynthesis.speak(utterance);
  };

  return (
    <button
      className="icon-button"
      type="button"
      aria-label={speaking ? "Stop reading aloud" : "Read response aloud"}
      aria-pressed={speaking}
      title={speaking ? "Stop reading aloud" : "Read response aloud"}
      onClick={toggleSpeak}
    >
      {speaking ? <VolumeX size={15} aria-hidden="true" /> : <Volume2 size={15} aria-hidden="true" />}
    </button>
  );
}
