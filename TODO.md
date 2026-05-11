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

- [ ] 完整学习计划进度可视化（已学 / 待学 / 复习曲线）
- [ ] 跨设备 db 同步（目前仅本地）
- [ ] 阅读理解专项（导入剑桥真题阅读篇章）
- [ ] 听力专项（基于 edge-tts 的 dictation / 听写填空）
- [ ] 整篇默写的智能 diff 显示（目前在 session.md 里手工标记）
- [ ] 错题专项练习模式（按 error_type 分类训练）
