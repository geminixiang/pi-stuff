export type SmellCategory =
  | "complexity"
  | "duplication"
  | "coupling"
  | "state"
  | "errors"
  | "performance"
  | "maintainability";

export type SmellSeverity = "low" | "medium" | "high";
export type SmellConfidence = "low" | "medium" | "high";
export type SmellAction = "inspect" | "delete" | "inline" | "extract" | "refactor" | "guard";

export type CodeSmellFinding = {
  category: SmellCategory;
  severity: SmellSeverity;
  confidence: SmellConfidence;
  file: string;
  lines: string;
  smell: string;
  evidence: string;
  impact: string;
  recommendation: string;
  action: SmellAction;
};

export type ProgrammaticCheck = {
  id: string;
  title: string;
  category: SmellCategory;
  severity: SmellSeverity;
  file: string;
  lines: string;
  evidence: string;
  recommendation: string;
};
