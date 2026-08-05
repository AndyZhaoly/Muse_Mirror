import { runAllMirrorSituationScenarios } from '../policy/mirrorSituationScenarios.js';

const results = runAllMirrorSituationScenarios();

for (const result of results) {
  const marker = result.passed ? 'PASS' : 'FAIL';
  const reasons = result.decision.reasonCodes.join(',');
  console.log(`${marker} ${result.scenarioId} action=${result.decision.action} reasons=${reasons}`);
  for (const mismatch of result.mismatches) console.error(`  ${mismatch}`);
}

const failures = results.filter((result) => !result.passed);
console.log(`Mirror situation scenarios: ${results.length - failures.length}/${results.length} passed.`);
if (failures.length > 0) process.exitCode = 1;
