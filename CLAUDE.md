# IELTSY — IELTS 学习闭环工具

## 项目本质

一个 **SQLite + Node CLI** 的 IELTS 学习工具。**Claude Code 本身就是 UI** —— 用户在终端里和你（Claude）对话，你调用本项目的 CLI 命令读写 SQLite，驱动每日学习闭环。

没有 web 前端，没有 API 调用。所有 AI 生成（短文、cloze 出题、判分）都在**你的回复里**完成。

## 用户交互规则

| 用户说 | 你应该做 |
|---|---|
| "今天学什么" / "开始" / "start" | 跑 `pnpm study:today`，根据输出生成今日短文 + 引导用户阅读 |
| "考一下我" / "默写" / "出题" | 把今日短文做成**多空填词**题（每句 3-5 空），让用户答 |
| "整篇默写" / "完整默写" | 启动整篇默写模式（只给第一句作为提示） |
| "下一句" / "继续" | 在 cloze 中推进到下一句 |
| "记一下" / "保存" / "存进度" | 跑 `pnpm study:record --correct "..." --incorrect "..." --mistakes-json '[...]'`，再跑 `pnpm study:render-mistakes` |
| "进度" / "progress" | 查询 `daily_sessions` + `word_progress` 展示 |
| "查 X" / "X 什么意思" | 直接查 `words` 表（用 sqlite3 CLI 或写临时脚本） |

## CLI 命令

```bash
# 一次性：建立学习计划
pnpm study:init --target-band 7 --target-date 2026-12-01 [--baseline B1] [--daily-words 17]

# 每日：获取今日任务
pnpm study:today                  # 人类可读 + 末尾 JSON
pnpm study:today --json           # 仅 JSON（输出 article_path / session_path / 新词 / 语法）
pnpm study:today --force          # 强制重新生成今日计划

# 每日：保存成绩（含详细错题）
pnpm study:record \
  --correct "123,456" \
  --incorrect "789" \
  --mistakes-json '[{"word_id":789,"context":"...","user_answer":"...","correct_answer":"...","error_type":"spelling"}]' \
  [--whole-dictation] [--notes "..."]
# 也支持 --mistakes-file path/to/mistakes.json（避免 shell 转义麻烦）

# 重新从 db 生成错题本 md（每次 record 后跑一次）
pnpm study:render-mistakes
```

`study:today` 输出末尾有一个 `--- DATA (JSON) ---` 段，包含完整结构化数据，**优先解析这个**。

## 学习产物文件（你来写）

`pnpm study:today` 会自动创建 `learning/days/YYYY-MM-DD/` 文件夹。你需要往里写两个文件：

### `learning/days/YYYY-MM-DD/article.md`

**何时写**：生成短文后立即写。用户呈现的内容和这个文件应该一致。

**模板**：

```markdown
# YYYY-MM-DD · GENRE · 短文标题

> 体裁: narrative | 字数: ~270 | 新词: 17/17 | 语法点: 一般现在时 #1

## 短文

① Sentence one.
② Sentence two.
...

## 目标词覆盖

| 词 | 出现 | 词 | 出现 |
|---|---|---|---|
| word1 | ① ⑦ | word2 | ④ |
...

## 语法点示例

**[语法点标题] · [描述]**

- 句 ①: "..." — 解释
- 句 ⑤: "..." — 解释
```

### `learning/days/YYYY-MM-DD/session.md`

**何时写**：cloze 测试完成、确认成绩之前写完。

**模板**：

```markdown
# YYYY-MM-DD · Session 记录

> Cloze 得分: X/Y · 整篇默写: 是/否 · 用时: ~Z 分钟

## 多空填词

### 第 1 句

> By the time he ____ at the office, the meeting ____ already ____.

- 空 1 (动词): 你答 `arrived` ✓
- 空 2 (助动词): 你答 `was` ✗ → 正确 `had`
- 空 3 (过去分词): 你答 `start` ✗ → 正确 `started`

### 第 2 句
...

## 整篇默写（如有）

[用户的默写 vs 原文 diff]

## 备注

[任何用户提到的备注 / 困惑 / 想问的]
```

### `learning/mistakes/words.md` 和 `learning/mistakes/grammar.md`

**不要手动写这两个文件**。它们由 `pnpm study:render-mistakes` 从 db 重新生成（覆盖式）。

错题在 db 的 `word_mistakes` 和 `grammar_mistakes` 表里。Claude Code 在 cloze 完成后，需要把每条错题作为 JSON 传给 `study:record --mistakes-json '[...]'`，db 会持久化。

错题 JSON 结构：
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

`error_type` 枚举：`spelling` / `similar-form` / `meaning` / `pos` / `unknown`

写完 record 后立即跑 `pnpm study:render-mistakes` 刷新 md 视图。

### `learning/README.md` 表格更新

学完一天后，把这一行追加到"学习日索引"表格里：

```markdown
| YYYY-MM-DD | narrative | 17 | 一般现在时 #1 | 5/7 | — |
```

## 短文生成规则（你来生成）

收到 `study:today` 的 JSON 后：

1. **取数据**：所有 `new_words[].headword` + `grammar.title` + `grammar.description`
2. **选体裁**（按当天 ISO 周几）：
   - 周一 = `narrative` 记叙文
   - 周二 = `argumentative` 议论文
   - 周三 = `descriptive` 描写文
   - 周四 = `expository` 说明文
   - 周五 = `dialogue` 对话
   - 周六 = `narrative`
   - 周日 = `argumentative`
3. **生成短文**：
   - 字数 **250 ± 50**
   - **每个**新词至少出现一次，自然嵌入
   - **至少一次**使用今日语法点，并明确标注
   - 句式有变化，避免堆砌
4. **输出格式**：
   ````
   ## 今日短文（NARRATIVE）

   [短文正文，每句单独一行便于后续 cloze]

   ---

   **目标词出现位置**：
   - word1: 句 2, 句 7
   - word2: 句 4
   ...

   **语法点示例**（过去完成时）：
   - 句 3: "By the time he arrived, she had already left."
   ````

## 多空填词规则（默认默写模式）

1. 从今日短文中选 5-7 个含目标新词的句子
2. 每句**至少 3 空**，最多 5 空（避免单空作弊）
3. 优先挖空：今日新词 > 高频功能词（介词、冠词、连接词）> 一般实词
4. **逐句**展示给用户，等用户填完再判断
5. 判断后告诉用户每个空对错 + 正确答案
6. 全部做完后，问用户："要保存进度吗？要的话我整理 correct/incorrect 列表跑 `pnpm study:record`"

填词题展示模板：

```
**第 1 句**：By the time he ____ at the office, the meeting ____ already ____.

提示：
- 空 1: 动词（动作）
- 空 2: 助动词
- 空 3: 动词的过去分词

你的答案？
```

## 整篇默写规则（可选挑战）

仅当用户主动要求时启用。流程：

1. 只显示标题或第一句作为开头
2. 用户分批默写（每次 1-2 句）
3. 你对照原文逐句判断，逐句标红错误（用 markdown 加粗/划线）
4. 全篇完成后，整体准确率 > 80% 视为通过
5. 记录到 session 的 `whole_dictation_done` 字段

## 复习算法（SM-2 简化）

`word_progress` 表维护每个词的：
- `interval_days`（下次复习间隔）
- `ease_factor`（难度系数，1.3–2.8）
- `repetitions`（连续答对次数）
- `next_review_date`（下次到期日）

`study:today` 自动把 `next_review_date <= 今天` 的词放进 `review_words` 数组。这些词应**和新词混在 cloze 里**测试，不要单独搞个"复习专区"。

`study:record` 会自动更新 SM-2：
- 答对：`interval *= ease`，`ease += 0.1`，`repetitions++`
- 答错：`interval = 1`，`ease -= 0.2`（下限 1.3），`repetitions = 0`
- `repetitions >= 5 且 interval >= 30 天` → 升级为 `mastered`，不再出现

## 新词选取优先级（已编码在 study:today）

1. CEFR 等级**升序**（A2 → B1 → B2 → C1）
2. 同等级：**AWL 词优先**
3. AWL 内：**sublist 编号升序**（1 = 最高频）

## 语法点选取优先级（已编码）

1. `importance` **降序**（★★★ → ★★ → ★）
2. `chapter` 升序（基础在前）
3. id 升序

## 关键文件

- `db/ieltsy.db` — SQLite 主数据库
- `db/schema.sql` — schema 定义
- `grammar/*.md` — 385 个语法点的源 md（已导入 db）
- `vocabulary/topics/*.md` — 30 个话题词汇的源 md（已导入 db）
- `scripts/study/` — 学习相关 CLI 命令
- `scripts/import-*.ts` — 数据导入脚本
- `data/` — 外部数据源（AWL JSON / Oxford CSV）

## 数据库 schema 速查

```sql
-- 内容表（一次性导入）
topics(id, slug, name_en, name_zh, category, display_order)
words(id, headword, pos, cefr_level, awl_sublist, oxford_3000/5000, definition_en, pronunciation_uk/us, ...)
word_topics(word_id, topic_id, section, importance)
word_forms(id, word_id, form, form_type)   -- AWL 派生词
examples(id, word_id, sentence, source)
collocations / idioms / cohesive_devices
grammar_points(id, chapter, section, title, importance, description)

-- 用户状态表
user_state(id=1, target_band, baseline_cefr, target_date, daily_new_words, daily_new_grammar)
word_progress(word_id PK, status, interval_days, ease_factor, repetitions, next_review_date)
grammar_progress(grammar_id PK, status)
daily_sessions(id, session_date UNIQUE, new_word_ids JSON, new_grammar_id, review_word_ids JSON, article_text, cloze_correct/total, whole_dictation_done)
```

## 开发约定

- TypeScript + tsx 运行（无构建步骤）
- better-sqlite3（同步 API，简单）
- 所有日期用 `YYYY-MM-DD` ISO 格式
- 内容表的修改 = 改 md → 跑 `pnpm db:import:*` 重新导入

## 第一次使用流程

```bash
# 1. 装依赖
pnpm install

# 2. 一次性建库 + 导入所有内容
pnpm db:reset

# 3. 建立学习计划（按目标 band 和截止日期）
pnpm study:init --target-band 7 --target-date 2026-12-01 --baseline B1

# 4. 之后每天，打开 Claude Code 说："今天学什么"
```
