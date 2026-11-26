import { z } from "zod";
import { recommendationDomainSchema } from "./recommendation-provider";

export const knowledgeDocumentSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{1,47}$/),
  title: z.string().trim().min(2).max(110),
  domain: recommendationDomainSchema,
  version: z.string().trim().min(1).max(20).default("1.0.0"),
  tags: z.array(z.string().trim().min(1).max(32)).max(10).default([]),
  content: z.string().trim().min(20).max(12_000),
  enabled: z.boolean().default(true),
  isBuiltIn: z.boolean().optional(),
  updatedAt: z.string(),
}).strict();
export type KnowledgeDocument = z.infer<typeof knowledgeDocumentSchema>;

export const knowledgeDocumentUpsertSchema = knowledgeDocumentSchema.omit({
  updatedAt: true,
  isBuiltIn: true,
});
export type KnowledgeDocumentUpsertInput = z.input<typeof knowledgeDocumentUpsertSchema>;

export interface KnowledgeCitation {
  docId: string;
  docTitle: string;
  version: string;
  domain: string;
  chunkIndex: number;
  score: number;
  bm25Score?: number;
  vectorScore?: number;
  excerpt: string;
}

export interface KnowledgeSearchResult {
  query: string;
  retrievalMode?: "hybrid_bm25_vector";
  citations: KnowledgeCitation[];
  suggestedFollowUp?: { label: string; prompt: string };
}

export interface KnowledgeBaseView {
  documents: (KnowledgeDocument & { chunkCount: number })[];
  totalChunks: number;
}
