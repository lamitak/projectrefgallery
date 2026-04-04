-- Lamitak Project Reference Gallery - D1 Schema

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS skus (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Uncategorized',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  date TEXT DEFAULT '',
  designer TEXT DEFAULT '',
  photographer TEXT DEFAULT '',
  description TEXT DEFAULT '',
  internal_only INTEGER DEFAULT 0,
  featured_image_id INTEGER DEFAULT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS project_sku_tags (
  project_id INTEGER NOT NULL,
  sku_id INTEGER NOT NULL,
  PRIMARY KEY (project_id, sku_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (sku_id) REFERENCES skus(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  url TEXT NOT NULL,
  caption TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_skus_code ON skus(code);
CREATE INDEX IF NOT EXISTS idx_skus_category ON skus(category);
CREATE INDEX IF NOT EXISTS idx_project_sku_tags_sku ON project_sku_tags(sku_id);
CREATE INDEX IF NOT EXISTS idx_project_images_project ON project_images(project_id);

-- Default categories
INSERT OR IGNORE INTO categories (name) VALUES ('Wood'), ('Metal'), ('Stone'), ('Glass'), ('Ceramic');

-- Default settings
INSERT OR IGNORE INTO settings (key, value) VALUES ('admin_username', 'admin');
INSERT OR IGNORE INTO settings (key, value) VALUES ('admin_password', 'admin123');
INSERT OR IGNORE INTO settings (key, value) VALUES ('admin_email', 'admin@lamitak.com');
