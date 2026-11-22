import { randomUUID } from "node:crypto";
import { z } from "zod";
import rawContent from "../../fixtures/content-catalog.json";
import rawReads from "../../fixtures/demo-balance-reads.json";
import { contentEntrySchema, metricValueSchema, type Candidate, type ContentEntry, type ContentDecision, type RouteDecision } from "../contracts/domain";

export const contentCatalog = z.object({
  schemaVersion: z.literal("1.0"),
  fixtureVersion: z.string(),
  catalogVersion: z.string(),
  dataClassification: z.literal("synthetic_demo_only"),
  entries: z.array(contentEntrySchema).max(50),
}).strict().parse(rawContent);
const contentById = new Map(contentCatalog.entries.map((entry) => [entry.contentId, entry]));
const readings = z.object({
  schemaVersion: z.literal("1.0"),
  fixtureVersion: z.string(),
  dataClassification: z.literal("synthetic_demo_only"),
  reads: z.array(z.object({
    personaId: z.string(), syntheticMid: z.string(), values: z.array(metricValueSchema).min(1).max(2),
  }).strict()),
}).strict().parse(rawReads);

if (contentById.size !== contentCatalog.entries.length || Buffer.byteLength(JSON.stringify(contentCatalog)) > 48_000) {
  throw new Error("Content fixtures exceed the current catalog limits or contain duplicate IDs");
}

export function resolveCandidates(ids: string[]) {
  const candidates: Candidate[] = [];
  const rejections: { contentId: string; stage: "catalog_resolution"; reasonCode: string }[] = [];
  ids.forEach((contentId, index) => {
    const content = contentById.get(contentId);
    if (!content || content.publicationStatus !== "published") {
      rejections.push({ contentId, stage: "catalog_resolution", reasonCode: content ? "CONTENT_WITHDRAWN" : "CONTENT_NOT_FOUND" });
      return;
    }
    candidates.push({
      candidateId: "candidate_" + randomUUID().replaceAll("-", ""),
      contentId, contentVersion: content.version, tsRank: index + 1,
    });
  });
  return { candidates, rejections };
}

export function lookupContent(candidate: Candidate): ContentEntry | undefined {
  const content = contentById.get(candidate.contentId);
  return content?.publicationStatus === "published" && content.version === candidate.contentVersion ? content : undefined;
}

const supplementalCards = [
  { contextId: "learning", task: "explain", primaryContentId: "retirement_learning", contentId: "beneficiary_update" },
  { contextId: "address-update", task: "guide", primaryContentId: "address_update_guide", contentId: "fund_account" },
];

export function eligibleSupplementalCard(decision: ContentDecision, route: RouteDecision) {
  const card = supplementalCards.find(({ contextId, task }) => contextId === route.contextId && task === route.intent.task);
  if (!card || !decision.candidates.some(({ contentId }) => contentId === card.primaryContentId)) return;
  const candidate = decision.candidates.find(({ contentId }) => contentId === card.contentId);
  if (candidate) return { primaryContentId: card.primaryContentId, candidate };
}

export function modelBundle(decision: ContentDecision, route?: RouteDecision) {
  const supplemental = route && eligibleSupplementalCard(decision, route);
  return {
    decisionId: decision.decisionId,
    partial: decision.partial,
    selectionMode: decision.selectionMode,
    candidates: decision.candidates.filter((candidate) => candidate !== supplemental?.candidate).map((candidate) => {
      const content = lookupContent(candidate);
      if (!content) throw new Error("CONTENT_UNAVAILABLE");
      return {
        candidateId: candidate.candidateId,
        tsRank: candidate.tsRank,
        kind: content.kind,
        title: content.title,
        description: content.description,
        body: content.body,
        allowedComponents: content.allowedComponents,
        comparisonGroup: content.comparisonGroup,
        comparisonFields: content.comparisonFields,
        steps: content.steps,
        requiresBalanceRead: content.metricSpec !== null,
        ...(content.allowedComponents.includes("PznGoalProgress") && { requiresGoalProgress: true }),
        ...(content.portfolioData && { requiresPortfolioSnapshot: true }),
        followUps: content.followUps.map(({ followUpId, label }) => ({ followUpId, label })),
      };
    }),
  };
}

export function readDemoBalance(personaId: string, syntheticMid: string, now: number) {
  const row = readings.reads.find((read) => read.personaId === personaId && read.syntheticMid === syntheticMid);
  if (!row) throw new Error("DEMO_BALANCE_UNAVAILABLE");
  return { fixtureVersion: readings.fixtureVersion, observedAt: new Date(now).toISOString(), values: row.values };
}
