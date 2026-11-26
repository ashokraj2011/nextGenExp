import { z } from "zod";
import { versionSchema } from "../contracts/agentic";
import { chatTreatmentSchema } from "../contracts/funding-workflow";
import { normalizedIdsSchema } from "../contracts/tool-setup";

const ranked = { id: z.string().min(1).max(100), rank: z.number().int().positive().max(100) };
const recommendationsV3 = z.object({
  schemaVersion: z.literal("3.0"),
  recommendations: z.array(z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("content"), ...ranked }).strict(),
    z.object({ kind: z.literal("capability"), ...ranked, version: versionSchema }).strict(),
    z.object({ kind: z.literal("workflow"), ...ranked, version: versionSchema }).strict(),
  ])).max(32),
}).strict();
export type Recommendation = z.infer<typeof recommendationsV3>["recommendations"][number];
export type TreatmentV3 = z.infer<typeof recommendationsV3>;

export function normalizeRecommendations(value: unknown): Recommendation[] {
  const legacy = normalizedIdsSchema.safeParse(value);
  if (legacy.success) return legacy.data.map((id, index) => ({ id, rank: index + 1, kind: "content" }));
  const v2 = chatTreatmentSchema.safeParse(value);
  if (v2.success) return v2.data.recommendations.map((item, index) => item.kind === "content"
    ? { ...item, rank: index + 1 }
    : { kind: item.kind === "action" ? "capability" : item.kind, id: item.id, version: item.version, rank: index + 1 });
  return recommendationsV3.parse(value).recommendations.slice().sort((a, b) => a.rank - b.rank);
}
