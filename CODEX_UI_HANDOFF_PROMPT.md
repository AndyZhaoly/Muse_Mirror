请先阅读 `AGENTS.md`、`README.md`、`UI_SPEC.md`、`ARCHITECTURE.md` 和 `API_CONTRACT.md`，并在前端工作时使用 `.agents/skills/build-camera-first-fashion-ui/SKILL.md`。

当前包里的 `web/` 已经是可运行的 React/Vite 起步壳：桌面端左侧是实时摄像头和视觉结果，右侧是 Agent；移动端上下排列。请不要推倒重做成通用 AI Dashboard。

先运行：

```bash
npm install
npm run check
npm --prefix web install
npm --prefix web run typecheck
npm --prefix web run build
npm run web:dev
```

然后完成 `CODEX_UI_TASK.md`：

- 保留 chat-first、自主工具选择的 Agent 架构；
- 不加入固定 intent classifier、关键词路由、mode enum 或强制流程；
- 摄像头实时画面默认只在本地，只有需要视觉上下文时才截取一帧；
- 把 Mock 对话替换成现有 turn/resume API adapter；
- 大图 artifact 放左侧，解释、推荐、授权和操作放右侧；
- 上身预览必须经过后端授权中断与恢复；
- 真实衣柜图、真实商品图、AI 搭配示意、AI 上身预览要清楚区分；
- 不向用户展示 Tool 名、Skill 名、JSON 或内部调度。

完成后运行全部后端检查以及 Web typecheck/build，并明确说明哪些真实 API 调用实际执行过。
