# IELTSY Design Pattern: Reading Proof

`Reading Proof` 把 IELTSY 视为一份持续出版的双语学习期刊，而不是后台、营销页或卡片集合。页面由期刊刊头、当期导读、课程账簿、阅读校样和注释轨道组成。

这份文档解释设计意图，但不单独构成约束。真正参与构建的规范是：

- `pattern.css`：唯一的 token、组件、布局、状态和响应式样式源。
- `runtime.js`：朗读、译文、跟读、遮词、默写和注释页签的统一交互模型。
- `scripts/study/check-design-pattern.ts`：构建门禁，检查页面结构、禁用模式、响应式规则和中文释义覆盖。

`pnpm pages:build` 会先用句子音频补齐 WordBoundary 节奏分析，再生成页面并执行 pattern check。不要在生成器里复制一份 CSS，也不要给单页添加内联样式。

## Visual Thesis

- 主体是高可读性的暖白校样纸，外部画布使用冷灰绿色，避免米色单调。
- 朱红负责编辑标记和主要动作，深青负责朗读与学习状态，黄色只标注目标词。
- 英文正文用系统衬线字体，UI 与中文释义用系统无衬线字体，编号和数据用等宽字体。
- 结构依靠细线、栏位和留白，不靠漂浮卡片、渐变、玻璃、装饰球或大面积阴影。
- 所有字距为 `0`；字号不随 viewport 连续缩放；控件最小高度为 `44px`。
- 页面与注释轨道使用不同尺寸的 tokenized scrollbar，并用稳定 gutter 避免内容切换时横向跳动；滚动条只在滚动或局部悬停时出现。
- 移动端刊头只保留品牌，主导航进入底部 dock；不要把桌面导航压成第二排堆在正文上方。

## Page Contracts

### Home

必须包含 `home-lead` 和 `archive-ledger`。首屏直接展示最新课程，下面是可扫描的课程账簿，不使用营销 Hero 或统计卡片阵列。

### Lesson

必须包含 `lesson-intro`、`study-toolbar`、`reading-sheet` 和 `annotation-rail`。正文在 DOM 中先于注释，移动端自然堆叠。译文默认隐藏，目标词中文释义必须完整。

`toggle-dictation` 开启中译英默写模式：正文只显示中文，英文、跟读、朗读入口与注释轨道都必须隐藏；退出后恢复用户原有阅读偏好。

每句 `RHYTHM` 必须来自页面实际发布的同一份 Edge TTS 音频：分组使用逐词时间轴中的真实停顿，语调读取对应音频区间，分析记录必须通过音频 SHA-256 校验。禁止发布按文本猜测的 fallback 节奏；句子 MP3 失败时也禁止静默切换到另一套浏览器 TTS。

### Mistakes

索引使用 `mistake-directory`；详情使用 `mistake-detail-layout` 和 `markdown-sheet`。错题内容保持自动生成，不在展示层改写。

### 404

使用 `not-found` 独立版式，并保留全站刊头和返回首页动作。

## Hard Invariants

- 不允许 `sh-*`、旧侧栏/卡片类或内联 `style`。
- 不允许 gradient、`transition: all`、负字距和 viewport 驱动的 `font-size: clamp(...)`。
- 不从网络导入字体；静态页面离线时仍应保持完整视觉层级。
- 每页有 skip link、语义化 masthead、唯一 `main#content` 和 footer。
- 图标按钮必须有可访问名称；所有按钮显式声明 `type="button"`。
- 支持 `375px`、`768px`、`1024px`、`1440px`，并尊重 `prefers-reduced-motion`。

## Verification

```bash
pnpm exec tsc --noEmit
IELTSY_SKIP_AUDIO=1 pnpm pages:build
```

首次生成新句子的节奏需要本机具备 `edge-tts`、Python 3 和 `ffmpeg`；后续构建会复用音频哈希一致的分析缓存。`IELTSY_SKIP_AUDIO=1` 只省略 `dist` 中的 MP3，不会跳过节奏一致性检查。

最后还要通过真实浏览器检查首页、最新课程、错题索引、错题详情和 404 的桌面/移动视口；构建检查不能替代视觉验收。
