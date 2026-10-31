CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS replies (id TEXT PRIMARY KEY,username TEXT,text TEXT,timestamp TEXT,first_seen_at TEXT NOT NULL,status TEXT NOT NULL,sent_at TEXT,published_id TEXT,error TEXT);
CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY AUTOINCREMENT,reply_id TEXT,username TEXT,status TEXT,at TEXT,error TEXT);
CREATE INDEX IF NOT EXISTS idx_replies_status ON replies(status);
