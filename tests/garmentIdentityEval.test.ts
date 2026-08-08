import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateIdentityCases } from '../src/evals/garmentIdentityEval.js';

test('identity eval reports false-existing, precision, and automation coverage', () => {
  const summary = evaluateIdentityCases([
    { caseId: 'same-ok', expected: 'same', actual: 'matched_existing' },
    { caseId: 'false-existing', expected: 'different', actual: 'matched_existing' },
    { caseId: 'new-ok', expected: 'different', actual: 'new_to_closet' },
    { caseId: 'deferred', expected: 'same', actual: 'ambiguous' },
  ]);
  assert.deepEqual(summary, {
    cases: 4,
    autoMatched: 2,
    autoNew: 1,
    ambiguous: 1,
    falseExisting: 1,
    falseNew: 0,
    autoMatchPrecision: 0.5,
    autoNewPrecision: 1,
    coverage: 0.75,
  });
});

test('identity eval avoids invented precision when no decision was automated', () => {
  const summary = evaluateIdentityCases([
    { caseId: 'ambiguous', expected: 'ambiguous', actual: 'insufficient_evidence' },
  ]);
  assert.equal(summary.autoMatchPrecision, null);
  assert.equal(summary.autoNewPrecision, null);
  assert.equal(summary.coverage, 0);
});
