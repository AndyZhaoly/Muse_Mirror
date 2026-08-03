请先阅读 `START_HERE_FOR_CODEX.md`。

这个包包含 v0.6 chat-first Fashion Agent 以及 camera-first Web Demo 的完整任务、设计系统、API 映射和静态视觉参考。

实现重点：

1. 保留主 Agent 自主决定直接回答、加载 Skill、调用零个/一个/多个 Tool 的能力；
2. 不加入固定 intent classifier、关键词路由、mode enum 或强制工作流；
3. Desktop 左侧是主视觉：实时摄像头、已分析快照、搭配图或上身预览；
4. Desktop 右侧是自然聊天的 Agent；
5. Mobile 为上方视觉、下方聊天、底部 sticky composer；
6. 本地摄像头实时显示，但默认只在需要时截取 snapshot 给模型；
7. 看本人上身效果前必须处理 photo consent、approval interruption 和 resume；
8. 真实衣柜图、商品图、AI 搭配示意和 AI 上身预览必须清楚标注；
9. 先跑通 mock 场景和全部 UI 状态，再接真实 Agent API；
10. 完成后执行 backend 与 frontend 的 typecheck、test 和 production build。

使用 `.agents/skills/build-camera-first-fashion-ui/SKILL.md`，并以 `CODEX_UI_TASK.md` 为 UI 验收标准。
