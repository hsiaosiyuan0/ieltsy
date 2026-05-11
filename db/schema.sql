-- ============================================================================
-- IELTS 内容数据库 v0
-- ============================================================================
-- 范围：内容表（words / grammar / topics / collocations / examples / idioms）
-- 暂不包含：用户表、进度表（待产品形态确定后追加）

PRAGMA foreign_keys = ON;

-- ============================================================================
-- Topics 话题
-- ============================================================================
CREATE TABLE IF NOT EXISTS topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name_en TEXT NOT NULL,
  name_zh TEXT NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('writing-task2','speaking-daily','functional','awl')),
  description TEXT,
  display_order INTEGER
);

-- ============================================================================
-- Words 词汇
-- ============================================================================
CREATE TABLE IF NOT EXISTS words (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  headword TEXT NOT NULL,
  pos TEXT NOT NULL DEFAULT 'unknown',
  pronunciation_uk TEXT,
  pronunciation_us TEXT,
  definition_en TEXT,
  definition_zh TEXT,
  cefr_level TEXT CHECK(cefr_level IN ('A1','A2','B1','B2','C1','C2')),
  awl_sublist INTEGER CHECK(awl_sublist BETWEEN 1 AND 10),
  oxford_3000 INTEGER DEFAULT 0,
  oxford_5000 INTEGER DEFAULT 0,
  ielts_band REAL,
  frequency_rank INTEGER,
  notes TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(headword, pos)
);
CREATE INDEX IF NOT EXISTS idx_words_headword ON words(headword);
CREATE INDEX IF NOT EXISTS idx_words_awl ON words(awl_sublist);
CREATE INDEX IF NOT EXISTS idx_words_cefr ON words(cefr_level);

-- ============================================================================
-- Word ↔ Topic 多对多
-- ============================================================================
CREATE TABLE IF NOT EXISTS word_topics (
  word_id INTEGER NOT NULL,
  topic_id INTEGER NOT NULL,
  section TEXT,
  importance INTEGER DEFAULT 2 CHECK(importance IN (1,2,3)),
  PRIMARY KEY (word_id, topic_id),
  FOREIGN KEY (word_id) REFERENCES words(id) ON DELETE CASCADE,
  FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_word_topics_topic ON word_topics(topic_id);

-- ============================================================================
-- Word forms 词形派生
-- ============================================================================
CREATE TABLE IF NOT EXISTS word_forms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word_id INTEGER NOT NULL,
  form TEXT NOT NULL,
  pos TEXT,
  form_type TEXT CHECK(form_type IN ('inflection','derivation','compound')),
  FOREIGN KEY (word_id) REFERENCES words(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_word_forms_word ON word_forms(word_id);

-- ============================================================================
-- Collocations 搭配
-- ============================================================================
CREATE TABLE IF NOT EXISTS collocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word_id INTEGER,
  collocation TEXT NOT NULL,
  pattern TEXT,
  meaning_zh TEXT,
  example TEXT,
  topic_id INTEGER,
  FOREIGN KEY (word_id) REFERENCES words(id) ON DELETE SET NULL,
  FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_collocations_topic ON collocations(topic_id);

-- ============================================================================
-- Examples 例句
-- ============================================================================
CREATE TABLE IF NOT EXISTS examples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word_id INTEGER NOT NULL,
  sentence TEXT NOT NULL,
  translation TEXT,
  source TEXT,
  FOREIGN KEY (word_id) REFERENCES words(id) ON DELETE CASCADE
);

-- ============================================================================
-- Idioms 习语
-- ============================================================================
CREATE TABLE IF NOT EXISTS idioms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phrase TEXT NOT NULL UNIQUE,
  meaning_en TEXT,
  meaning_zh TEXT,
  example TEXT,
  topic_id INTEGER,
  register TEXT CHECK(register IN ('formal','informal','neutral')),
  FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE SET NULL
);

-- ============================================================================
-- Cohesive devices 连接词
-- ============================================================================
CREATE TABLE IF NOT EXISTS cohesive_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device TEXT NOT NULL UNIQUE,
  function_category TEXT NOT NULL,
  position TEXT,
  register TEXT CHECK(register IN ('academic','spoken','neutral')),
  example TEXT
);

-- ============================================================================
-- Grammar points 语法点
-- ============================================================================
CREATE TABLE IF NOT EXISTS grammar_points (
  id INTEGER PRIMARY KEY,
  chapter INTEGER NOT NULL,
  section TEXT,
  title TEXT NOT NULL,
  importance INTEGER NOT NULL CHECK(importance IN (1,2,3)),
  description TEXT,
  examples_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_grammar_chapter ON grammar_points(chapter);
CREATE INDEX IF NOT EXISTS idx_grammar_importance ON grammar_points(importance);

-- ============================================================================
-- 用户状态与进度（v0: 单用户 CLI）
-- ============================================================================

-- 单例：用户的学习计划
CREATE TABLE IF NOT EXISTS user_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  target_band REAL NOT NULL,
  baseline_cefr TEXT CHECK(baseline_cefr IN ('A1','A2','B1','B2','C1','C2')),
  start_date TEXT NOT NULL DEFAULT (date('now')),
  target_date TEXT NOT NULL,
  daily_minutes INTEGER DEFAULT 30,
  daily_new_words INTEGER NOT NULL DEFAULT 17,
  daily_new_grammar INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 词学习进度 + SM-2 状态
CREATE TABLE IF NOT EXISTS word_progress (
  word_id INTEGER PRIMARY KEY,
  first_seen_date TEXT NOT NULL,
  last_reviewed_date TEXT,
  status TEXT NOT NULL CHECK(status IN ('new','learning','review','mastered')) DEFAULT 'learning',
  interval_days INTEGER NOT NULL DEFAULT 1,
  ease_factor REAL NOT NULL DEFAULT 2.5,
  repetitions INTEGER NOT NULL DEFAULT 0,
  next_review_date TEXT NOT NULL,
  total_reviews INTEGER DEFAULT 0,
  correct_reviews INTEGER DEFAULT 0,
  FOREIGN KEY (word_id) REFERENCES words(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_word_progress_next ON word_progress(next_review_date);
CREATE INDEX IF NOT EXISTS idx_word_progress_status ON word_progress(status);

-- 语法学习进度
CREATE TABLE IF NOT EXISTS grammar_progress (
  grammar_id INTEGER PRIMARY KEY,
  first_seen_date TEXT NOT NULL,
  last_reviewed_date TEXT,
  status TEXT NOT NULL CHECK(status IN ('new','studied','reviewing','mastered')) DEFAULT 'studied',
  FOREIGN KEY (grammar_id) REFERENCES grammar_points(id) ON DELETE CASCADE
);

-- 每日学习会话
CREATE TABLE IF NOT EXISTS daily_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_date TEXT NOT NULL UNIQUE,
  new_word_ids TEXT,                 -- JSON array
  new_grammar_id INTEGER,
  review_word_ids TEXT,              -- JSON array
  article_genre TEXT,
  article_path TEXT,                 -- 相对路径 learning/days/YYYY-MM-DD/article.md
  session_path TEXT,                 -- 相对路径 learning/days/YYYY-MM-DD/session.md
  cloze_correct INTEGER DEFAULT 0,
  cloze_total INTEGER DEFAULT 0,
  whole_dictation_done INTEGER DEFAULT 0,
  notes TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (new_grammar_id) REFERENCES grammar_points(id)
);

-- 单词错题记录（每条 = 一次具体的答错事件）
CREATE TABLE IF NOT EXISTS word_mistakes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word_id INTEGER NOT NULL,
  session_id INTEGER NOT NULL,
  context TEXT NOT NULL,             -- 句子原文，空位用 ___ 标注
  user_answer TEXT NOT NULL,
  correct_answer TEXT NOT NULL,
  error_type TEXT CHECK(error_type IN ('spelling','similar-form','meaning','pos','unknown')) DEFAULT 'unknown',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (word_id) REFERENCES words(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES daily_sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_word_mistakes_word ON word_mistakes(word_id);
CREATE INDEX IF NOT EXISTS idx_word_mistakes_session ON word_mistakes(session_id);
CREATE INDEX IF NOT EXISTS idx_word_mistakes_created ON word_mistakes(created_at);

-- 语法错题记录
CREATE TABLE IF NOT EXISTS grammar_mistakes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  grammar_id INTEGER,
  session_id INTEGER NOT NULL,
  context TEXT NOT NULL,
  user_answer TEXT NOT NULL,
  correct_answer TEXT NOT NULL,
  error_note TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (grammar_id) REFERENCES grammar_points(id) ON DELETE SET NULL,
  FOREIGN KEY (session_id) REFERENCES daily_sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_grammar_mistakes_session ON grammar_mistakes(session_id);
