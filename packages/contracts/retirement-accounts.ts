import { z } from "zod";

const account = z.object({
  id: z.string().regex(/^RET-\d{4}$/), label: z.string().trim().min(1).max(80),
}).strict();
export const retirementAccountSchema = account.extend({ beneficiary: z.string().trim().min(1).max(80).nullable() });
export const retirementViewSchema = z.object({
  title: z.string().max(90), accounts: z.array(account).max(12), selected: retirementAccountSchema.nullable(),
}).strict();
export type RetirementView = z.infer<typeof retirementViewSchema>;
export const retirementListIntent = "list_retirement_accounts";
export const retirementBeneficiaryIntent = "show_account_beneficiary";

export function retirementAccountRequest(message: string, hasAccountContext: boolean) {
  const text = message.toLowerCase().trim();
  if (/\b(?:what (?:is|are) (?:a|an)|who can be|explain|learn about|how (?:does|do) (?:an? )?(?:ira|401)|difference between|compare types)\b/.test(text)) return;
  const asksBeneficiary = /beneficiar/.test(text);
  const accountType = /\b(?:retirement accounts?|iras?|401\s*\(?k)\b/.test(text);
  if (accountType) {
    const personalAccount = /\b(?:my|the) (?:rollover ira|roth ira|traditional ira|(?:workplace )?401\s*\(?k)\b/.test(text);
    return asksBeneficiary || personalAccount || /\b(?:first|second|last|ending)\b/.test(text)
      ? retirementBeneficiaryIntent : retirementListIntent;
  }
  if (/\bret-\d{4}\b/.test(text) || (asksBeneficiary && /(?:who|which person|whom|name).{0,45}beneficiar|beneficiar.{0,30}(?:on file|named|listed|second|first|account)/.test(text))) return retirementBeneficiaryIntent;
  if (!hasAccountContext) return;
  if (asksBeneficiary) return retirementBeneficiaryIntent;
  if (/\b(?:balances?|portfolio|transfers?|goals?|address|orders?|shares?|stocks?)\b/.test(text)) return;
  if (/\b(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|last|other|this one|that one|ending|\d+(?:st|nd|rd|th))\b/.test(text)
    || /^(?:account |option |number |#)?\d{1,2}[.?!]?$/.test(text)) return retirementBeneficiaryIntent;
}
