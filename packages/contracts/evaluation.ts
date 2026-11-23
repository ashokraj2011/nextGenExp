export type EvaluationRow = {
  path: "fast" | "goal";
  turns: number;
  completed: number;
  medianMs: number | null;
  modelCalls: number;
  toolCalls: number;
  tokens: number;
};
