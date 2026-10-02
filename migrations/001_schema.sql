-- BIR Compliance System schema.
-- Packages, event reports, upload attempts and the audit log are write-once:
-- triggers reject every UPDATE and DELETE, even from outside the application.

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(60) NOT NULL UNIQUE,
  full_name VARCHAR(120) NOT NULL,
  role ENUM('admin','accounting','treasury') NOT NULL,
  password_hash VARCHAR(100) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  failed_attempts INT NOT NULL DEFAULT 0,
  locked_until DATETIME NULL,
  last_login_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Onsite betting servers allowed to send packages (their Ed25519 public keys).
CREATE TABLE IF NOT EXISTS betting_servers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  server_id VARCHAR(60) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  public_key_b64 VARCHAR(64) NOT NULL,
  key_fingerprint CHAR(16) NOT NULL UNIQUE,
  status ENUM('active','revoked') NOT NULL DEFAULT 'active',
  registered_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Accepted, verified closing packages. One per (server, sequence).
CREATE TABLE IF NOT EXISTS packages (
  id INT AUTO_INCREMENT PRIMARY KEY,
  server_id VARCHAR(60) NOT NULL,
  sequence_no INT UNSIGNED NOT NULL,
  event_id INT NOT NULL,
  seal_code CHAR(19) NOT NULL,
  payload_sha256 CHAR(64) NOT NULL UNIQUE,
  prev_payload_sha256 CHAR(64) NOT NULL,
  key_fingerprint CHAR(16) NOT NULL,
  payload LONGTEXT NOT NULL,
  signature TEXT NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  file_sha256 CHAR(64) NOT NULL,
  stored_path VARCHAR(255) NOT NULL,
  checks JSON NOT NULL,
  ack_code VARCHAR(40) NOT NULL,
  ack_signature TEXT NOT NULL,
  received_at DATETIME NOT NULL,
  received_by INT NOT NULL,
  UNIQUE KEY uq_server_sequence (server_id, sequence_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Key figures per event, extracted from the verified payload for reporting.
CREATE TABLE IF NOT EXISTS event_reports (
  package_id INT PRIMARY KEY,
  server_id VARCHAR(60) NOT NULL,
  event_id INT NOT NULL,
  event_name VARCHAR(200) NOT NULL,
  event_date DATE NOT NULL,
  commission_rate DECIMAL(6,4) NOT NULL,
  fights_total INT NOT NULL,
  fights_completed INT NOT NULL,
  fights_draw INT NOT NULL,
  fights_cancelled INT NOT NULL,
  gross_bets DECIMAL(16,2) NOT NULL,
  voided_bets DECIMAL(16,2) NOT NULL,
  net_bets DECIMAL(16,2) NOT NULL,
  refunds DECIMAL(16,2) NOT NULL,
  winnings DECIMAL(16,2) NOT NULL,
  commission DECIMAL(16,2) NOT NULL,
  breakage DECIMAL(16,2) NOT NULL,
  house_take DECIMAL(16,2) NOT NULL,
  payable DECIMAL(16,2) NOT NULL,
  paid DECIMAL(16,2) NOT NULL,
  unclaimed DECIMAL(16,2) NOT NULL,
  flagged_checks INT NOT NULL,
  KEY idx_event_date (event_date),
  CONSTRAINT fk_report_package FOREIGN KEY (package_id) REFERENCES packages(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Every upload, accepted or rejected (rejections are evidence too).
CREATE TABLE IF NOT EXISTS upload_attempts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  file_name VARCHAR(255) NOT NULL,
  file_sha256 CHAR(64) NOT NULL,
  server_id VARCHAR(60) NULL,
  sequence_no INT UNSIGNED NULL,
  result ENUM('accepted','duplicate','rejected') NOT NULL,
  reasons JSON NOT NULL,
  uploaded_by INT NOT NULL,
  uploaded_from VARCHAR(64) NULL,
  uploaded_at DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tax rules are configured, never hard-coded. Rules are retired, not deleted.
CREATE TABLE IF NOT EXISTS tax_rules (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  authority ENUM('LGU','BIR') NOT NULL,
  lgu VARCHAR(120) NULL,
  legal_basis VARCHAR(200) NOT NULL,
  tax_base ENUM('house_take','commission','net_bets','gross_bets') NOT NULL,
  rate DECIMAL(8,5) NOT NULL,
  effective_from DATE NOT NULL,
  effective_to DATE NULL,
  created_by INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  retired_by INT NULL,
  retired_at DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Append-only, hash-chained audit log.
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  at DATETIME(3) NOT NULL,
  user_id INT NULL,
  username VARCHAR(60) NULL,
  role VARCHAR(20) NULL,
  ip VARCHAR(64) NULL,
  action VARCHAR(60) NOT NULL,
  entity VARCHAR(60) NULL,
  entity_id VARCHAR(60) NULL,
  detail JSON NULL,
  prev_hash CHAR(64) NOT NULL,
  hash CHAR(64) NOT NULL,
  KEY idx_audit_at (at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
