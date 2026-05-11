# TODO / Roadmap

> 未完成的素材扩充和功能扩展。不阻塞核心学习闭环（db 已有 7,090 词，覆盖 Band 7 主动词汇 ROI 最高部分），但能让覆盖更完整。

## 内容扩展

### 词汇深度

- [ ] **各话题词汇扩到 100–150 词** — 当前每个 topic 约 50 词，Band 7 标准应该 100–150
- [ ] **学科专业词汇** — 从剑桥真题语料抽取（需要源语料）
- [ ] **易混词组（confusing pairs）** — `lay/lie` / `raise/rise` / `affect/effect` / `since/for` 等系统化整理（目前散见于 `grammar/12-common-errors.md`）
- [ ] **抽象概念词专题** — 思想 / 自由 / 公正 / 责任 等议论文核心词

### 词汇广度

- [ ] **颜色 / 形状 / 材质 / 尺寸描述词专题** — 目前散见于 clothing / scenery 等话题
- [ ] **数字 / 日期 / 时间表达专题**
- [ ] **词根词缀拆解表** — 系统化派生词训练（部分内容在 `grammar/10-writing-advanced-and-formation.md` §25 构词法）

### 已完成

- [x] **AWL Sublist 1–10（570 word families）** — 通过 `data/awl.json` + `pnpm db:import:awl` 完整入库（含 2,539 个派生词到 `word_forms` 表）
- [x] **Oxford 3000 / 5000（CEFR A1–C1）** — 通过 `data/oxford_*.csv` + `pnpm db:import:oxford` 入库，含 5,902 例句

## 产品 / 工程

### HTML 单点页面扩展（高优先）

按"重交互走 HTML、数据回流 sqlite + md"的原则：

- [ ] **Cloze HTML 模式** — 多空填词的交互形态。LLM 生成题目写入 `cloze.md` / db，HTML 渲染带 `<input>` 的句子，用户逐句填，即时校对，提交后 server 写入 `word_mistakes` + 同步 `session.md`。比对话式 cloze 快 5-10 倍。
- [ ] **整篇默写 HTML 模式** — 隐藏文本 + 大文本框，分段提交，server 跟原文 diff 后写 session.md
- [ ] **进度 / 错题可视化 dashboard** — 学习曲线、SM-2 到期分布、错题热力图

### 工作流 / 命令

- [ ] **Claude Code Skill** — 把工作流封装成 `/ielts today` / `/ielts cloze` 这种 slash command，省去用户每次自然语言触发

### 内容专项

- [ ] 阅读理解专项（导入剑桥真题阅读篇章）
- [ ] 听力专项（基于 edge-tts 的 dictation / 听写填空）
- [ ] 错题专项练习模式（按 error_type 分类训练）

### 其他

- [ ] 跨设备 db 同步（目前仅本地）
