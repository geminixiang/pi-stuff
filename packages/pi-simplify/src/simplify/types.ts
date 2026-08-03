export type Category = "reuse" | "quality" | "efficiency";
export type Risk = "safe" | "confirm" | "review";
export type Action = "delete" | "inline" | "refactor" | "parallelize";

export type SimplifyResult = {
  category: Category;
  file: string;
  lines: string;
  /** The underlying problem with the current code. */
  rootIssue: string;
  /** What this problem leads to if left unchanged. */
  consequence: string;
  /** The concrete advantage gained after applying the fix. */
  benefit: string;
  risk: Risk;
  action: Action;
};
