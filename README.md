# IELTSY

> 由 Claude Code 驱动的 IELTS Band 7 学习闭环工具。SQLite + Node CLI，没有前端，没有 LLM API 调用。

## 是什么

在 Claude Code 终端里说一句"今天学什么"，AI 根据你的学习计划：

1. 从词库挑出 17 个新词 + 1 个语法点（按 CEFR / AWL / 重要度排序）
2. 生成一篇 ~250 字短文，把所有目标词织进去（体裁按周几轮换：narrative / argumentative / descriptive / expository / dialogue）
3. 出多空填词题让你考（每句 3–5 空）
4. 记录错题到 SQLite，SM-2 算法自动调度间隔重复

所有 AI 生成都在 Claude Code 的回复里完成；CLI 只负责读写数据库和外设（朗读 / 浏览器预览）。

## 内容规模

- **7,090 词** — Oxford 5000 (A1-C1 with CEFR) + AWL Sublist 1-10 (570 word families) + IELTS topic vocab
- **368 语法点** — 12 章 / 按 ★★★ / ★★ / ★ 三级重要度分级
- **30 个话题词汇** — 15 个 Writing Task 2 议题向 + 15 个 Speaking 日常向
- 5,902 例句 + 2,539 派生词 + 258 搭配（从 Oxford / 手工源 md 导入）

## 快速开始

```bash
# 系统依赖：Node 22+，pnpm 10+，edge-tts（pip install edge-tts 或 brew install），macOS afplay

pnpm install
pnpm db:reset                          # 一次性建库 + 全量导入

pnpm ielts init \
  --target-band 7 \
  --target-date 2026-12-01 \
  --baseline B1                        # 你的当前 CEFR

# 之后每天，打开 Claude Code 说"今天学什么"
```

## CLI

所有日常操作都走 `pnpm ielts <cmd>` 入口：

```bash
pnpm ielts help              # 列出所有子命令
pnpm ielts help <cmd>        # 单个子命令的参数 + notes
pnpm ielts help --json       # 全套 metadata as JSON（LLM-friendly）
```

主要子命令：

| 命令 | 作用 |
|---|---|
| `init` | 一次性建立学习计划（目标分 + 截止日期 + 基础水平） |
| `today` | 获取今日新词 + 语法 + 复习队列 |
| `record` | 保存 cloze 成绩 + SM-2 更新 + 错题入库 |
| `add-word` | 任意词加入学习队列（用户阅读中遇到的生词） |
| `speak` | edge-tts 朗读（默认自然美音 Jenny，可换 UK / 男声 / 不同语速） |
| `preview` | 启动本地 HTTP 服务，浏览器预览今日文章，点击句子/单词朗读 |
| `export-pages` | 导出 GitHub Pages 静态站点（手机阅读 / 朗读 / 遮词复习） |
| `mistakes` | 从 db 重新生成错题本 md |

## GitHub Pages 发布

发布版是**纯静态只读站点**：从 `learning/days/YYYY-MM-DD/article.md` 和 `learning/mistakes/*.md` 生成 HTML，适合手机继续阅读、浏览器朗读、遮词练习和本地标记完成。SQLite 进度、SM-2 调度和错题写入仍在本地 CLI 里完成。

```bash
pnpm pages:build
# 输出 dist/，可直接打开 dist/index.html 预览
```

仓库已包含 `.github/workflows/deploy-pages.yml`。推送到 GitHub 后，在仓库 Settings → Pages 里把 Source 设为 **GitHub Actions**；之后每次 push `main` 都会自动发布 `dist/`。

注意：GitHub Actions 只能发布已经 commit 的学习日志。新一天学完后，把对应的 `learning/days/YYYY-MM-DD/article.md`、`learning/README.md` 和错题本改动提交上去，手机端才会看到。

## 架构

```
ieltsy/
├── CLAUDE.md             ← Claude Code 工作流手册（会话开始自动加载）
├── README.md             ← 你正在看的这份
├── package.json
├── db/
│   ├── schema.sql        ← 13 张表（内容 9 + 用户进度 4）
│   └── ieltsy.db         ← SQLite 主库（gitignored）
├── data/                 ← 权威外部词表（AWL JSON, Oxford 3000/5000 CSV）
├── grammar/              ← 12 章语法源 md（已导入 db）
├── vocabulary/           ← 30 个话题 + 6 个功能词库源 md（已导入 db）
├── scripts/
│   ├── cli.ts            ← 统一 CLI 入口
│   ├── study/            ← 各子命令实现
│   └── import-*.ts       ← 数据导入脚本
└── learning/
    ├── days/YYYY-MM-DD/  ← 每天的 article.md + session.md
    ├── mistakes/         ← 错题本 md（db 视图，由 mistakes 命令生成）
    └── audio-cache/      ← TTS 缓存（gitignored）
```

数据库 schema 细节看 `db/schema.sql`，工作流细节看 `CLAUDE.md`。

## 一次学习的样子

```
你: 今天学什么
Claude:
  → 跑 pnpm ielts today
  → 看到 17 个新词 + 一般现在时 + 0 个待复习
  → 生成 narrative 短文 "Maria, the Consultant" (270 字)
  → 写到 learning/days/2026-05-11/article.md（含中文翻译）
  → 在对话里展示文章 + 目标词位置 + 语法点示例

你: 考一下我
Claude:
  → 从短文里选 6 句，每句挖 3-5 空
  → 逐句出题，你填，Claude 判分

你: 保存
Claude:
  → 整理 correct/incorrect 词 ID + 错题详情
  → 跑 pnpm ielts record --correct "..." --incorrect "..." --mistakes-json '[...]'
  → 跑 pnpm ielts mistakes 刷新错题本
  → SM-2 算法把错的词排到明天复习

你: 预览
Claude:
  → 后台跑 pnpm ielts preview
  → 浏览器自动打开 http://localhost:8765
  → 点击句子朗读（edge-tts 美音）、可切中/英文显示、Play All 朗读整篇

你: consultant 这个词不会
Claude:
  → 跑 pnpm ielts add-word --word consultant
  → 加入学习队列，明天复习时出现
```

## 技术栈

- **TypeScript + tsx** — 无构建步骤，直接跑
- **better-sqlite3** — 同步 API，简单可靠
- **edge-tts** — Microsoft Edge 在线 TTS，免费、声音自然
- **Node `http` 模块** — 零框架本地预览服务

## 设计原则

### 三层架构

| 层 | 实现 | 职责 |
|---|---|---|
| **存储** | SQLite + Markdown | 内容、用户进度、学习产物 |
| **数据流转 / 编排** | CLI + LLM（Claude Code） | 自然语言指令 → 命令调用 + 智能生成 / 判分 |
| **重交互场景** | HTML 单点页面 | 视觉/操作密集的垂直场景；所有操作写回 SQLite + md |

### 存储分工

- **SQLite (`db/ieltsy.db`)** — 结构化查询索引：内容表（7,090 词 + 368 语法点 + 30 话题）、用户进度表（学习计划、SM-2、daily_sessions、word_mistakes）、学习产物的文件路径
- **Markdown** — 教学素材源（`grammar/*.md` / `vocabulary/*.md`，importer 据此填 db）+ 学习产物（`learning/days/.../article.md` / `session.md`、`learning/mistakes/*.md`）

### 数据流转 / 编排

`pnpm ielts <cmd>` 是统一 CLI，每条命令自带 `help` 和 `--json` 元数据。**Claude Code 是默认编排器**，按 `CLAUDE.md` 工作流读用户意图、调命令、生成短文 / cloze / 判分。也可以裸跑 CLI 自动化（脚本、cron）。

未来扩展：把高频工作流封装成 Claude Code Skill（`/ielts today` slash command），减少 LLM 触发负担。

### 重交互场景：HTML 单点页面

轻量交互（一个空填词、对话问答）走 LLM 对话；**重交互**（读整篇 + 听音频 + 切语言 + 17 个空反复输入对错）走 HTML 单页。原则：
- 启动本地 HTTP 服务（无前端框架，原生 Node `http`）
- 浏览器自动打开 / 用户手动访问
- **所有用户操作经服务端写回 SQLite + md**（HTML 自己不持久化）

| 已实现 | TODO |
|---|---|
| `pnpm ielts preview` — 文章阅读 + 句子/单词朗读 + 中英切换 | Cloze 测试 HTML 模式（多空填词的交互形态） |
| | 整篇默写 HTML 模式 |
| | 进度 / 错题可视化 dashboard |

### 其他

- 数据导入幂等：改源 md → `pnpm db:import:*` 重新跑
- 个人单用户场景，无多用户 / 鉴权
- 全部本地（db + cache 都 gitignored，但 commit 整个 repo 可跨机器复刻状态）
