const numericFact = /(?:[$€£]\s*\d|\b\d[\d,.]*\s*(?:USD|dollars?|units)\b)/i;
const accountFact = /\b(?:your (?:account|available balance|current balance|portfolio|cash|transfer|deposit|savings|balance|beneficiar\w*)|you (?:have|hold|own|qualify|are eligible))[^.?!]{0,90}\b(?:funded|unfunded|eligible|holds?|totals?|remaining|qualified|approved|\d+)\b/i;
const operationClaim = /\b(?:I (?:made|completed|processed|sent|updated|changed|placed|confirmed|executed)|(?:transfer|deposit|withdrawal|order|address change) (?:went through|has been (?:completed|processed|submitted)|was (?:completed|processed|submitted)))\b/i;
const unapprovedRecommendation = /\b(?:recommend (?:you |that you )?(?:buy|invest|purchase|transfer|deposit|add funds|open)|(?:you should|go ahead and) (?:buy|invest|fund|deposit|open an account(?: with)?)|available exclusively for you)\b/i;

export function conversationalTextAllowed(text: string) {
  return !numericFact.test(text) && !accountFact.test(text) && !operationClaim.test(text) && !unapprovedRecommendation.test(text);
}
