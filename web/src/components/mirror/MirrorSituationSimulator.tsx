import type { MirrorSituationScenarioResult } from '../../../../src/policy/mirrorSituationScenarios.js';
import type { MirrorSituationScenario } from '../../../../src/policy/mirrorSituationScenarios.js';

interface MirrorSituationSimulatorProps {
  scenarios: readonly MirrorSituationScenario[];
  selectedScenarioId: string;
  result?: MirrorSituationScenarioResult;
  onSelect: (scenarioId: string) => void;
}

const actionLabels: Record<MirrorSituationScenarioResult['decision']['action'], string> = {
  remain_silent: '保持安静',
  observe_more: '继续观察',
  defer: '延后处理',
  ask_ownership: '询问衣物归属',
  privacy_pause: '隐私暂停',
  candidate_ready: '候选条件满足',
};

const eligibilityLabels = {
  prohibited: '禁止',
  eligible: '允许',
  requires_user_confirmation: '需用户确认',
} as const;

export function MirrorSituationSimulator({
  scenarios,
  selectedScenarioId,
  result,
  onSelect,
}: MirrorSituationSimulatorProps) {
  const selected = scenarios.find((scenario) => scenario.id === selectedScenarioId);

  return (
    <section className="mirror-situation-simulator" aria-label="镜前情境策略开发模拟器">
      <header>
        <div>
          <span>DEVELOPER ONLY</span>
          <strong>Mirror Situation Policy Simulator</strong>
        </div>
        <label>
          <span>固定场景</span>
          <select
            value={selectedScenarioId}
            onChange={(event) => onSelect(event.target.value)}
          >
            <option value="">关闭模拟</option>
            {scenarios.map((scenario) => (
              <option key={scenario.id} value={scenario.id}>{scenario.title}</option>
            ))}
          </select>
        </label>
      </header>

      {selected && result && (
        <div className="mirror-situation-simulator-result">
          <div>
            <span>Observation</span>
            <strong>{selected.title}</strong>
            <p>{selected.description}</p>
          </div>
          <dl>
            <div><dt>Decision</dt><dd>{actionLabels[result.decision.action]}</dd></div>
            <div><dt>Wear record</dt><dd>{eligibilityLabels[result.decision.eligibility.wearRecord]}</dd></div>
            <div><dt>Candidate</dt><dd>{eligibilityLabels[result.decision.eligibility.garmentCandidate]}</dd></div>
            <div><dt>Persistence</dt><dd>{eligibilityLabels[result.decision.eligibility.closetPersistence]}</dd></div>
          </dl>
          <div className="mirror-situation-reasons">
            <span>Reason codes</span>
            <code>{result.decision.reasonCodes.join(' · ')}</code>
          </div>
          <span className={`mirror-situation-golden ${result.passed ? 'is-passing' : 'is-failing'}`}>
            {result.passed ? 'Golden fixture passed' : result.mismatches.join('; ')}
          </span>
        </div>
      )}
    </section>
  );
}
