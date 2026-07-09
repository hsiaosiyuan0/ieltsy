# IELTSY - Codex CLI Repository Guide

## Project Essence

IELTSY is a local IELTS study loop built from SQLite + a Node CLI. **Codex CLI is the UI/orchestrator**: the user talks to Codex in the terminal, Codex calls `pnpm ielts <cmd>` to read/write data, and AI generation such as articles, cloze questions, grading, and feedback happens in Codex replies. There is no web frontend for the main flow and no LLM API call inside the app.

`CLAUDE.md` is the previous Claude Code guide. Keep this `AGENTS.md` as the source of truth for Codex CLI, and keep the two files in sync only if Claude Code compatibility matters.

## Command Entry Point

Run all study commands through `pnpm ielts`; do not call `scripts/study/*.ts` directly.

```bash
pnpm ielts help                # list subcommands
pnpm ielts help <cmd>          # details for one subcommand
pnpm ielts help --json         # full metadata as JSON for the agent
```

If command shape is uncertain at the start of a session, run `pnpm ielts help` first.

## User Intent Routing

| User says | Codex should do |
|---|---|
| "今天学什么" / "今天学点啥" / "开始" | Run `pnpm ielts today`, then generate the article and guide reading. |
| "考一下我" / "默写" / "出题" | Start multi-blank cloze mode, 3-5 blanks per sentence, one sentence at a time. |
| "整篇默写" | Hide the article and ask the user to dictate it in batches, then compare against the original sentence by sentence. |
| "记一下" / "保存" | Run `pnpm ielts record ... --mistakes-json '[...]'`, then `pnpm ielts mistakes`. |
| "查 X" / "X 什么意思" | Query the SQLite `words` table, using `db/schema.sql` if table shape is needed. |
| "读 X" / "读这句" | Run `pnpm ielts speak --text "..."`. |
| "预览文章" / "看一下文章" | Start `pnpm ielts preview` as a long-running background process and report the local URL. |
| "加 X" / "X 这词不会" | Run `pnpm ielts add-word --word X`. |

## Daily Article Generation

After `pnpm ielts today` returns JSON:

1. Read `new_words[].headword`, `grammar.title`, and `grammar.description`.
2. Use the returned `article_genre`; it is computed from ISO weekday and rotates through `narrative`, `argumentative`, `descriptive`, `expository`, and `dialogue`.
3. Generate an English article of about 250 words, with a tolerance of +/-50 words.
4. Use every new word at least once in a natural context.
5. Use the grammar point at least once.
6. Write both daily files under `learning/days/YYYY-MM-DD/`, using JSON fields `article_path` and `session_path`.

### `article.md` Template

```markdown
# YYYY-MM-DD · GENRE · Article Title

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

- 句 ①: "..." - 解释
- 句 ⑤: "..." - 解释
```

Critical constraints:

- Prefix article and translation sentences with circled numbers `①②③...` (`U+2460` through `U+2473`); the preview parser depends on them.
- Always include `## 中文翻译`; preview uses a toggle and hides it by default.
- Render genre in the title as uppercase: `NARRATIVE`, `ARGUMENTATIVE`, `DESCRIPTIVE`, `EXPOSITORY`, or `DIALOGUE`.

### `session.md` Template

Write this after cloze finishes and before running `record`.

```markdown
# YYYY-MM-DD · Session

> Cloze: X/Y · 整篇默写: 是/否

## 多空填词

### 第 1 句

> By the time he ____ at the office, the meeting ____ already ____.

- 空 1 (动词): `arrived` ✓
- 空 2 (助动词): `was` ✗ -> `had`
- 空 3 (过去分词): `start` ✗ -> `started`

## 整篇默写（如有）
[默写 vs 原文 diff]

## 备注
[用户提到的困惑 / 想问的]
```

## Cloze Rules

1. Choose 5-7 sentences from today's article that contain new words.
2. Each sentence must have at least 3 blanks and at most 5 blanks.
3. Blank priority: today's new words first, then high-frequency function words such as prepositions/articles/connectors, then normal content words.
4. Ask one sentence at a time. Grade only after the user answers that sentence.
5. After all questions, run `pnpm ielts record`, passing `--mistakes-json` with detailed mistakes.
6. Then run `pnpm ielts mistakes` to refresh mistake markdown files.

## Mistake JSON Shape

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

Allowed `error_type` values: `spelling`, `similar-form`, `meaning`, `pos`, `unknown`.

## Whole-Article Dictation

Only enable this when the user asks for it.

1. Show only the title or the beginning of the first sentence.
2. Let the user dictate in batches of 1-2 sentences.
3. Compare each sentence against the original and mark errors clearly.
4. Accuracy above 80% counts as passing.
5. Pass `--whole-dictation` when recording the session.

## Review Mechanism

`pnpm ielts today` automatically puts due review words in `review_words`.

- Mix review words into cloze questions together with new words.
- Do not create a separate review-only section unless the user asks for one.
- After `record`, SM-2 computes the next review date; do not edit that manually.

## Key Files And Directories

| Path | Purpose |
|---|---|
| `db/ieltsy.db` | Main SQLite database, gitignored. |
| `db/schema.sql` | Database schema. |
| `grammar/`, `vocabulary/` | Source markdown imported into the database. |
| `data/` | External vocabulary sources such as AWL JSON and Oxford CSV. |
| `scripts/cli.ts` | Main CLI entry for `pnpm ielts`. |
| `scripts/study/*.ts` | Subcommand implementations; do not call directly for normal workflows. |
| `learning/days/YYYY-MM-DD/` | Daily article and session output. |
| `learning/mistakes/` | Mistake markdown generated from database views; do not edit manually. |
| `learning/audio-cache/` | TTS MP3 cache, gitignored. |

## Development Conventions

- TypeScript + `tsx`; there is no build step.
- SQLite access uses `better-sqlite3` synchronous APIs.
- Dates are ISO `YYYY-MM-DD`.
- For content changes, edit markdown sources and rerun the relevant `pnpm db:import:*` command.
- For schema changes, either add backward-compatible `ALTER TABLE` migrations or tell the user to run `pnpm db:reset`.
- Use `pnpm ielts help --json` when automating or parsing command metadata.

## First Use

```bash
pnpm install
pnpm db:reset
pnpm ielts init --target-band 7 --target-date 2026-12-01 --baseline B1
# After that, open Codex CLI in this repo and say "今天学什么"
```
