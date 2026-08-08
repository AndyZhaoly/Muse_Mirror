import type { GarmentIdentityStatus } from '../domain/ambientCapture.js';

export type IdentityEvalExpected = 'same' | 'different' | 'ambiguous';

export interface IdentityEvalCase {
  caseId: string;
  expected: IdentityEvalExpected;
  actual: GarmentIdentityStatus;
  candidateId?: string;
  notes?: string;
}

export interface IdentityEvalSummary {
  cases: number;
  autoMatched: number;
  autoNew: number;
  ambiguous: number;
  falseExisting: number;
  falseNew: number;
  autoMatchPrecision: number | null;
  autoNewPrecision: number | null;
  coverage: number;
}

export function evaluateIdentityCases(cases: IdentityEvalCase[]): IdentityEvalSummary {
  const autoMatched = cases.filter((entry) => entry.actual === 'matched_existing').length;
  const autoNew = cases.filter((entry) => entry.actual === 'new_to_closet').length;
  const ambiguous = cases.filter((entry) =>
    entry.actual === 'ambiguous' || entry.actual === 'insufficient_evidence').length;
  const falseExisting = cases.filter((entry) =>
    entry.actual === 'matched_existing' && entry.expected !== 'same').length;
  const falseNew = cases.filter((entry) =>
    entry.actual === 'new_to_closet' && entry.expected !== 'different').length;
  const correctMatches = cases.filter((entry) =>
    entry.actual === 'matched_existing' && entry.expected === 'same').length;
  const correctNew = cases.filter((entry) =>
    entry.actual === 'new_to_closet' && entry.expected === 'different').length;
  return {
    cases: cases.length,
    autoMatched,
    autoNew,
    ambiguous,
    falseExisting,
    falseNew,
    autoMatchPrecision: autoMatched ? correctMatches / autoMatched : null,
    autoNewPrecision: autoNew ? correctNew / autoNew : null,
    coverage: cases.length ? (autoMatched + autoNew) / cases.length : 0,
  };
}
