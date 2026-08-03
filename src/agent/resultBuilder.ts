import type { RunResult } from '@openai/agents';
import { drainArtifacts } from '../runtime/artifacts.js';
import type {
  AgentActivity,
  ApprovalRequiredTurnResult,
  ApprovalRequest,
  CompletedTurnResult,
  FashionAgentContext,
  FashionTurnResult,
} from '../types.js';
import { approvalReason } from '../policy/policyReasons.js';

function outputToText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output === undefined || output === null) return '';
  return JSON.stringify(output);
}

function toolLogToActivity(context: FashionAgentContext): AgentActivity[] {
  return context.state.toolLog.slice(-8).map((entry) => ({
    id: entry.id,
    type: entry.status === 'ok' ? 'wardrobe.completed' : 'wardrobe.failed',
    turnId: context.turnId,
    timestamp: Date.parse(entry.completedAt) || Date.now(),
    status: entry.status === 'ok' ? 'completed' : 'failed',
    label: entry.toolName,
    displayDetail: entry.summary,
    detail: {
      toolName: entry.toolName,
      status: entry.status,
    },
  }));
}

export function buildTurnResult(
  result: RunResult<FashionAgentContext, any>,
  context: FashionAgentContext,
): FashionTurnResult {
  const artifacts = drainArtifacts(context.state);
  const interruptions = result.interruptions ?? [];

  if (interruptions.length > 0) {
    const approvals: ApprovalRequest[] = interruptions.map((item, index) => ({
      index,
      toolName: item.name ?? 'unknown_tool',
      arguments:
        typeof item.arguments === 'string'
          ? item.arguments
          : JSON.stringify(item.arguments),
      reason: approvalReason(item.name ?? 'unknown_tool'),
    }));
    const pending: ApprovalRequiredTurnResult = {
      status: 'approval_required',
      approvals,
      serializedRunState: result.state.toString(),
      artifacts,
      activity: toolLogToActivity(context),
    };
    return pending;
  }

  const completed: CompletedTurnResult = {
    status: 'completed',
    text: outputToText(result.finalOutput),
    artifacts,
    activity: toolLogToActivity(context),
    state: {
      activeOutfitId: context.state.activeOutfit?.id,
      lastGeneratedImageId: context.state.lastGeneratedImageId,
      currentUserImageId: context.state.currentUserImageId,
      perception: context.state.perception,
    },
  };
  return completed;
}
