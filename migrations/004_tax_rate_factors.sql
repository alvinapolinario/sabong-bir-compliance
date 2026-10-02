-- A tax rule may be a chain of percentages applied in order, e.g. an ordinance
-- tax of (gross bets x 7%) x 14% (Operator Safety Net) x 1%. "factors" keeps
-- each step (JSON [{"pct":"7","label":"…"}, …]); "rate" is their exact product.
-- Rates need more than 5 decimals for such chains (7% x 14% x 1% = 0.000098).
ALTER TABLE tax_rules MODIFY rate DECIMAL(20,12) NOT NULL
--;;
ALTER TABLE tax_rules ADD COLUMN IF NOT EXISTS factors VARCHAR(500) NULL AFTER rate
--;;
DROP TRIGGER IF EXISTS tax_rules_only_retire
--;;
CREATE TRIGGER tax_rules_only_retire BEFORE UPDATE ON tax_rules FOR EACH ROW
  IF NOT (NEW.name <=> OLD.name AND NEW.authority <=> OLD.authority AND NEW.lgu <=> OLD.lgu
      AND NEW.legal_basis <=> OLD.legal_basis AND NEW.tax_base <=> OLD.tax_base AND NEW.rate <=> OLD.rate
      AND NEW.factors <=> OLD.factors
      AND NEW.effective_from <=> OLD.effective_from AND NEW.created_by <=> OLD.created_by
      AND NEW.created_at <=> OLD.created_at) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Tax rules cannot be edited; retire and add a new rule';
  END IF
