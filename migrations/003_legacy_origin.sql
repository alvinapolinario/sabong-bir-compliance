-- Distinguish events sealed live at the arena from events reconstructed later
-- from database backups ("legacy"). Senders are registered as live or legacy.
ALTER TABLE betting_servers ADD COLUMN IF NOT EXISTS kind ENUM('live','legacy') NOT NULL DEFAULT 'live' AFTER name;
ALTER TABLE event_reports ADD COLUMN IF NOT EXISTS origin ENUM('live','legacy') NOT NULL DEFAULT 'live' AFTER server_id;
