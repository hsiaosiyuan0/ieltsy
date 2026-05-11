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
| `speak` | edge-tts 朗读（默认美音 Aria，可换 UK / 男声 / 不同语速） |
| `preview` | 启动本地 HTTP 服务，浏览器预览今日文章，点击句子/单词朗读 |
| `mistakes` | 从 db 重新生成错题本 md |

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

## 关键约束

- 一切持久化数据在 SQLite，md 文件是**人类可读视图**
- 数据导入幂等：改源 md → `pnpm db:import:*` 重新跑
- 个人单用户场景，没有多用户 / 鉴权
- 没有云同步，全部在本地（db + cache 都 gitignored，但 commit 整个 repo 可以跨机器复刻）
