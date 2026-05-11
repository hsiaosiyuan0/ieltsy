# IELTSY — IELTS 学习闭环工具

## 项目本质

SQLite + Node CLI 的 IELTS 学习工具。**Claude Code 本身就是 UI** —— 用户在终端里和你（Claude）对话，你调用 `pnpm ielts <cmd>` 读写数据库；AI 生成（短文、cloze、判分）都在**你的回复里**完成。没有 web 前端，没有 LLM API 调用。

## 工作流入口

**所有命令都通过 `pnpm ielts` 调用**，不要直接调底层 `scripts/study/*.ts`。

```bash
pnpm ielts help                # 列出所有子命令
pnpm ielts help <cmd>          # 单个子命令的详细参数 + notes
pnpm ielts help --json         # 全套 metadata as JSON（给 LLM 解析）
```

会话开始如果不确定命令形态，先跑一次 `pnpm ielts help` 即可。

## 用户交互规则

| 用户说 | 你应该做 |
|---|---|
| "今天学什么" / "开始" | 跑 `pnpm ielts today`，按输出生成短文 + 引导阅读 |
| "考一下我" / "默写" / "出题" | 多空填词模式（每句 3–5 空），逐句出题 |
| "整篇默写" | 隐藏短文，用户分批默写，逐句对照原文 |
| "记一下" / "保存" | `pnpm ielts record ... --mistakes-json '[...]'`，再 `pnpm ielts mistakes` |
| "查 X" / "X 什么意思" | sqlite3 查 `words` 表 |
| "读 X" / "读这句" | `pnpm ielts speak --text "..."` |
| "预览文章" / "看一下文章" | `pnpm ielts preview` ⚠️ **必须 `run_in_background: true`** |
| "加 X" / "X 这词不会" | `pnpm ielts add-word --word X` |

## 短文生成规则

收到 `pnpm ielts today` 的 JSON 后：

1. **取数据**：`new_words[].headword` + `grammar.title` + `grammar.description`
2. **体裁** = JSON 返回的 `article_genre`（按 ISO 周几自动算：narrative / argumentative / descriptive / expository / dialogue）
3. **生成**：~250 字（±50），**每个新词至少出现一次**（自然嵌入），**语法点至少用一次**
4. **写两份产物**到 `learning/days/YYYY-MM-DD/`（路径由 JSON 的 `article_path` / `session_path` 给定）

### article.md 模板

```markdown
# YYYY-MM-DD · GENRE · 短文标题

> 体裁: narrative | 字数: ~270 | 新词: 17/17 | 语法点: 一般现在时 #1

## 短文

① English sentence one.
② English sentence two.
...

## 中文翻译

① 中文翻译一。
② 中文翻译二。
...

## 目标词覆盖（N/N）

| # | 词 | POS | 出现 |
|---|---|---|---|
| 1 | word1 | v | ① ⑦ |
| 2 | word2 | n | ④ |

## 语法点示例

**[语法点标题] · [描述]**

- 句 ①: "..." — 解释
- 句 ⑤: "..." — 解释
```

**关键约束：**
- 句子前必须用 ①②③ 圈数字（U+2460–U+2473），preview 解析靠这个
- **中文翻译段必须有**（preview 里有 toggle 显示，默认隐藏）
- 体裁标题大写：`NARRATIVE` / `ARGUMENTATIVE` / `DESCRIPTIVE` / `EXPOSITORY` / `DIALOGUE`

### session.md 模板

cloze 结束、调 record 前写：

```markdown
# YYYY-MM-DD · Session

> Cloze: X/Y · 整篇默写: 是/否

## 多空填词

### 第 1 句

> By the time he ____ at the office, the meeting ____ already ____.

- 空 1 (动词): `arrived` ✓
- 空 2 (助动词): `was` ✗ → `had`
- 空 3 (过去分词): `start` ✗ → `started`

## 整篇默写（如有）
[默写 vs 原文 diff]

## 备注
[用户提到的困惑 / 想问的]
```

## 多空填词规则

1. 从今日短文选 5–7 个含新词的句子
2. **每句至少 3 空**（避免单空作弊），最多 5 空
3. 挖空优先级：**今日新词 > 高频功能词（介词/冠词/连接词）> 一般实词**
4. 逐句出题，用户答完一句再判，给正确答案
5. 全部做完后调 `pnpm ielts record`，传 `--mistakes-json` 包含错题详情
6. 再调 `pnpm ielts mistakes` 刷新错题本 md

## 错题 JSON 结构

```json
[
  {
    "word_id": 2200,
    "context": "Her job requires her to ___ complex business situations.",
    "user_answer": "assets",
    "correct_answer": "assess",
    "error_type": "similar-form"
  }
]
```

`error_type`: `spelling` / `similar-form` / `meaning` / `pos` / `unknown`

## 整篇默写（可选挑战）

仅在用户主动要求时启用：

1. 只显示标题或第一句开头
2. 用户分批默写（每次 1-2 句）
3. 逐句对照原文，标红错误
4. 准确率 > 80% 视为通过
5. record 时传 `--whole-dictation`

## 复习机制

`pnpm ielts today` 自动把到期复习的词放进 `review_words` 数组。
- 这些词应**和新词混在 cloze 里**测试，不单独"复习专区"
- record 后 SM-2 自动算下一次到期（已封装，无需手动）

## 关键文件 / 目录

| 路径 | 内容 |
|---|---|
| `db/ieltsy.db` | SQLite 主库（gitignored） |
| `db/schema.sql` | schema 定义（查表结构看这里） |
| `grammar/`, `vocabulary/` | 源 markdown 内容（已导入 db） |
| `data/` | 外部词表（AWL JSON / Oxford CSV） |
| `scripts/cli.ts` | CLI 主入口（`pnpm ielts`） |
| `scripts/study/*.ts` | 子命令实现（不要直接调） |
| `learning/days/YYYY-MM-DD/` | 每日产物（article.md + session.md） |
| `learning/mistakes/` | 错题本（db 视图，**不手动编辑**） |
| `learning/audio-cache/` | TTS mp3 缓存（gitignored） |

## 开发约定

- TS + tsx，无构建步骤
- better-sqlite3（同步 API）
- 日期统一 ISO `YYYY-MM-DD`
- 内容变更：改 md → `pnpm db:import:*` 重导
- schema 变更：要么 ALTER TABLE 兼容旧库，要么提示 `pnpm db:reset`

## 第一次使用

```bash
pnpm install
pnpm db:reset                       # 建库 + 全量导入内容
pnpm ielts init --target-band 7 --target-date 2026-12-01 --baseline B1
# 之后每天，打开 Claude Code 说"今天学什么"
```
