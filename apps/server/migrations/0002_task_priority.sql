-- Task priority: higher claims first, FIFO within a priority band.
-- 10 = user-initiated, 5 = auto-advance, 0 = bulk/background (default).
ALTER TABLE task_queue ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_task_queue_claim ON task_queue(state, priority DESC, id);
