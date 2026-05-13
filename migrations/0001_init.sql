CREATE TABLE IF NOT EXISTS sent_tasks (
  key TEXT PRIMARY KEY,
  sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sent_tasks_sent_at ON sent_tasks(sent_at);
