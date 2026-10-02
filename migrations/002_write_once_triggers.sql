-- Write-once protection. Each statement is separated by a line containing only "--;;".
DROP TRIGGER IF EXISTS packages_no_update
--;;
CREATE TRIGGER packages_no_update BEFORE UPDATE ON packages FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Accepted packages cannot be modified'
--;;
DROP TRIGGER IF EXISTS packages_no_delete
--;;
CREATE TRIGGER packages_no_delete BEFORE DELETE ON packages FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Accepted packages cannot be deleted'
--;;
DROP TRIGGER IF EXISTS event_reports_no_update
--;;
CREATE TRIGGER event_reports_no_update BEFORE UPDATE ON event_reports FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Event reports cannot be modified'
--;;
DROP TRIGGER IF EXISTS event_reports_no_delete
--;;
CREATE TRIGGER event_reports_no_delete BEFORE DELETE ON event_reports FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Event reports cannot be deleted'
--;;
DROP TRIGGER IF EXISTS upload_attempts_no_update
--;;
CREATE TRIGGER upload_attempts_no_update BEFORE UPDATE ON upload_attempts FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Upload records cannot be modified'
--;;
DROP TRIGGER IF EXISTS upload_attempts_no_delete
--;;
CREATE TRIGGER upload_attempts_no_delete BEFORE DELETE ON upload_attempts FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Upload records cannot be deleted'
--;;
DROP TRIGGER IF EXISTS audit_log_no_update
--;;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Audit log entries cannot be modified'
--;;
DROP TRIGGER IF EXISTS audit_log_no_delete
--;;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Audit log entries cannot be deleted'
--;;
DROP TRIGGER IF EXISTS tax_rules_no_delete
--;;
CREATE TRIGGER tax_rules_no_delete BEFORE DELETE ON tax_rules FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Tax rules are retired, never deleted'
--;;
DROP TRIGGER IF EXISTS tax_rules_only_retire
--;;
CREATE TRIGGER tax_rules_only_retire BEFORE UPDATE ON tax_rules FOR EACH ROW
  IF NOT (NEW.name <=> OLD.name AND NEW.authority <=> OLD.authority AND NEW.lgu <=> OLD.lgu
      AND NEW.legal_basis <=> OLD.legal_basis AND NEW.tax_base <=> OLD.tax_base AND NEW.rate <=> OLD.rate
      AND NEW.effective_from <=> OLD.effective_from AND NEW.created_by <=> OLD.created_by
      AND NEW.created_at <=> OLD.created_at) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Tax rules cannot be edited; retire and add a new rule';
  END IF
