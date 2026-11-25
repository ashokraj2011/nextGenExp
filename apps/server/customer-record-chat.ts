import type { DynamicCanvasProps } from "../../packages/contracts/dynamic-canvas";
import type { IntegrationTaskService } from "./integration-tasks";
import type { TurnRecord, WatchSource } from "./store";

export const watchRequest = /\b(?:tell|notify|alert|let) me (?:know )?when\b|\b(?:watch|track) (?:it|this|that|the status)\b/i;

type Reply = {
  text: string;
  subject?: NonNullable<TurnRecord["customerTask"]>;
  canvas?: DynamicCanvasProps;
  watch?: WatchSource & { value: string };
};

export async function answerCustomerLookup(service: IntegrationTaskService, principal: string, mid: string, message: string,
  previous?: TurnRecord["customerTask"]): Promise<Reply | undefined> {
  const reads = service.customerReads();
  const matches = reads.filter((c) => {
    const b = c.customerExperience!;
    return new RegExp("\\b" + b.idPrefix + "-[a-z0-9]+\\b", "i").test(message)
      || (new RegExp("\\b" + b.topic + "s?\\b", "i").test(message) && /\b(where|status|lookup|look up|check|track|delivery)\b/i.test(message));
  });
  const fromNamedSource = matches.filter((c) => message.toLowerCase().includes(c.integrationId));
  const configured = matches.filter((c) => c.integrationId !== "commerce_sandbox");
  const candidates = fromNamedSource.length ? fromNamedSource : configured.length ? configured : matches;
  if (candidates.length > 1) return { text: "Which source should I check? Include the record ID and a source name: " + candidates.map((r) => r.integrationId).join(", ") + "." };

  const confirmWatch = previous?.confirmWatch && /^(?:yes|please do|sure|ok|okay)[.! ]*$/i.test(message.trim());
  const watching = watchRequest.test(message) || Boolean(confirmWatch);
  const followUp = watching || /^(?:what (?:changed|is next)|show me the summary|and (?:now|the status))[?.! ]*$/i.test(message.trim());
  const contract = candidates[0] ?? (previous && followUp ? reads.find((c) => c.ref === previous.ref) : undefined);
  if (!contract?.customerExperience) return;
  const binding = contract.customerExperience;
  const ids = [...new Set(message.toUpperCase().match(new RegExp("\\b" + binding.idPrefix + "-[A-Z0-9]+\\b", "g")) ?? [])];
  if (ids.length > 1) return { text: "Which " + binding.topic + " should I look up? Send one ID." };
  const recordId = ids[0] ?? (previous?.ref === contract.ref ? previous.recordId : undefined);
  if (!recordId) return { text: "What is the " + binding.topic + " ID? It starts with " + binding.idPrefix + "-." };

  let read;
  try { read = await service.customerRead(principal, mid, contract.ref, recordId); }
  catch { return { text: "I couldn’t reach the source for " + recordId + ". Please try again." }; }
  if (!read) return { text: "I couldn’t verify that record for your account. Check the ID or try again later." };
  const subject = { ref: contract.ref, recordId, runId: read.runId, sfieldRunId: read.sfieldRunId, sfieldCallId: read.sfieldCallId };
  if (!watching) return {
    text: "Here is the latest status for " + recordId + ".", subject,
    canvas: { title: recordId, badge: binding.topic, dataSource: contract.ref, recordId, generatedBy: "synthesizer",
      nodes: [{ type: "table", columns: ["Detail", "Value"], rows: read.fields.map((f) => [f.label, f.value.slice(0, 80)]) }],
      disclaimer: "Read from " + contract.integrationId + "." },
  };
  const target = binding.watch?.value;
  if (!target || read.watchValue === undefined) return { subject, text: "This source supports lookups only. You can check its status again here." };
  if (!confirmWatch && !message.toLowerCase().includes(target.toLowerCase()) && !/\b(?:watch|track) (?:it|this|that)\b/i.test(message)) {
    return { subject: { ...subject, confirmWatch: true }, text: "I can watch for “" + target + "”. Is that the update you want?" };
  }
  if (read.watchValue === target) return { subject, text: recordId + " is already " + target + "." };
  const label = recordId + " reaches " + target;
  return { subject, watch: { kind: "task", ref: contract.ref, recordId, target, label, value: read.watchValue },
    text: "I’ll post an update in this conversation when " + label + ". Its current status is " + read.watchValue + "." };
}
