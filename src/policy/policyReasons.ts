const reasons: Record<string, string> = {
  analyze_current_view: '该工具将读取并分析当前授权的用户照片或摄像头帧。',
  generate_outfit_visual: '该工具将调用 AI 图像模型生成搭配示意图。',
  generate_try_on_preview: '该工具将使用用户照片生成 AI 上身预览。',
  edit_try_on_preview: '该工具将继续处理当前用户的 AI 上身预览图。',
  save_user_preference: '该工具可能把用户偏好保存为跨会话长期记忆。',
};

export function approvalReason(toolName: string): string {
  return reasons[toolName] ?? '该工具需要用户批准后才能执行。';
}
