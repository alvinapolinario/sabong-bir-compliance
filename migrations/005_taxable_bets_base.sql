-- Tax base "taxable_bets": bets on fights that had a winner (net bets minus the
-- draw/cancelled pools that were refunded) = the pool the commission is taken
-- from = winnings + commission + rounding. Computed from sealed figures.
ALTER TABLE tax_rules MODIFY tax_base ENUM('house_take','commission','net_bets','gross_bets','taxable_bets') NOT NULL
