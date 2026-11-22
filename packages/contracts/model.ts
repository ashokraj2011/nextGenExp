import Ajv2020 from "ajv/dist/2020.js";
import type { ContextSelectionProposal, ExperienceProposal } from "./domain";
import { contextProposalSchema } from "./model-schemas";
import experienceSchema from "./schemas/experience-proposal.schema.json";

export * from "./model-schemas";

const ajv = new Ajv2020({ strict: true, validateFormats: false });
export const isContextProposal = ajv.compile<ContextSelectionProposal>(contextProposalSchema);
export const isExperienceProposal = ajv.compile<ExperienceProposal>(experienceSchema);
