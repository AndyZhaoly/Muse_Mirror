import type {
  FashionAgentContext,
  OutfitCandidate,
  OutfitEvaluation,
} from '../types.js';

const formalOccasionWords = ['面试', '客户', '商务', '会议', '婚礼', '宴会', 'interview', 'business'];
const casualShoeWords = ['拖鞋', '洞洞鞋', 'slipper'];

function clamp(value: number): number {
  return Math.max(0, Math.min(10, Math.round(value * 10) / 10));
}

export class OutfitEvaluatorService {
  evaluate(
    outfit: OutfitCandidate,
    context: FashionAgentContext,
  ): OutfitEvaluation {
    const issues: string[] = [];
    const fixes: string[] = [];
    const strengths: string[] = [];

    const colors = new Set(outfit.items.map((item) => item.color.toLowerCase()));
    const hasShoes = outfit.items.some((item) => item.category === 'shoes');
    const oversizedCount = outfit.items.filter((item) =>
      (item.fit ?? '').toLowerCase().includes('oversize'),
    ).length;
    const occasion = outfit.occasion ?? '';
    const formal = formalOccasionWords.some((word) => occasion.toLowerCase().includes(word));
    const casualShoes = outfit.items.some(
      (item) =>
        item.category === 'shoes' &&
        casualShoeWords.some((word) => item.name.toLowerCase().includes(word)),
    );

    let occasionScore = 8;
    if (formal && casualShoes) {
      occasionScore -= 4;
      issues.push('鞋子的正式度明显低于场合。');
      fixes.push('替换为简洁乐福鞋、皮鞋或符合行业语境的干净鞋款。');
    }

    let colorScore = 8.5;
    if (colors.size > 4) {
      colorScore -= 2.5;
      issues.push('大面积颜色较多，主次可能不够清晰。');
      fixes.push('保留一个主色和一个辅助色，把其他颜色缩小为点缀。');
    } else {
      strengths.push('颜色数量可控，容易形成整体感。');
    }

    let silhouetteScore = 8;
    if (oversizedCount >= 3) {
      silhouetteScore -= 2.5;
      issues.push('多件宽大单品叠加，整体可能缺少收束点。');
      fixes.push('通过腰线、袖口、脚踝或更利落的鞋型增加收束。');
    }

    let proportionScore = 8;
    if (outfit.stylingActions?.some((action) => action.includes('提高腰线'))) {
      proportionScore += 0.5;
      strengths.push('方案包含明确的腰线或视觉重心处理。');
    }

    let completenessScore = hasShoes ? 8.5 : 5.5;
    if (!hasShoes) {
      issues.push('完整方案没有说明鞋子，正式度和量感无法闭合。');
      fixes.push('补充与裤脚、场合和整体量感协调的鞋。');
    }

    const avoid = context.state.persistentPreferences.avoidItems;
    if (Array.isArray(avoid)) {
      const violation = outfit.items.find((item) =>
        avoid.some((term) => item.name.includes(term)),
      );
      if (violation) {
        issues.push(`方案包含用户长期排斥的单品：${violation.name}。`);
        occasionScore -= 3;
      }
    }

    const overallScore = clamp(
      (occasionScore + colorScore + silhouetteScore + proportionScore + completenessScore) / 5,
    );
    const pass =
      overallScore >= 7.5 &&
      occasionScore >= 6.5 &&
      colorScore >= 6.5 &&
      silhouetteScore >= 6.5 &&
      completenessScore >= 6.5;

    if (issues.length === 0) strengths.push('没有检测到明显的场合或搭配硬伤。');

    return {
      overallScore,
      occasionScore: clamp(occasionScore),
      colorScore: clamp(colorScore),
      silhouetteScore: clamp(silhouetteScore),
      proportionScore: clamp(proportionScore),
      completenessScore: clamp(completenessScore),
      pass,
      strengths,
      issues,
      suggestedFixes: fixes,
    };
  }
}
