import fs from 'node:fs/promises';
import path from 'node:path';
import {
  evaluateIdentityCases,
  type IdentityEvalCase,
  type IdentityEvalExpected,
} from '../evals/garmentIdentityEval.js';

const root = path.resolve(process.argv[2] ?? '.local/identity-eval');
const files = await listJsonFiles(root).catch((error: NodeJS.ErrnoException) => {
  if (error.code === 'ENOENT') return [];
  throw error;
});
const cases: IdentityEvalCase[] = [];
for (const file of files) {
  const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
  const expected = String(parsed.expected);
  const trace = isRecord(parsed.trace) ? parsed.trace : undefined;
  const actual = String(parsed.actual ?? trace?.finalDecision ?? '');
  if (!isExpected(expected) || !isActual(actual)) {
    throw new Error(`Invalid identity eval case: ${path.relative(root, file)}`);
  }
  cases.push({
    caseId: String(parsed.caseId ?? path.basename(file, '.json')),
    expected,
    actual,
    candidateId: typeof parsed.candidateId === 'string' ? parsed.candidateId : undefined,
    notes: typeof parsed.notes === 'string' ? parsed.notes : undefined,
  });
}

console.log(JSON.stringify({ root, ...evaluateIdentityCases(cases) }, null, 2));
if (!cases.length) {
  console.error('No local identity eval cases found. Add gitignored JSON cases under .local/identity-eval/.');
}

async function listJsonFiles(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return listJsonFiles(target);
    return entry.isFile() && entry.name.endsWith('.json') ? [target] : [];
  }));
  return nested.flat().sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isExpected(value: string): value is IdentityEvalExpected {
  return value === 'same' || value === 'different' || value === 'ambiguous';
}

function isActual(value: string): value is IdentityEvalCase['actual'] {
  return value === 'matched_existing' || value === 'new_to_closet' ||
    value === 'ambiguous' || value === 'insufficient_evidence';
}
