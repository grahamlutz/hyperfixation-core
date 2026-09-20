ALTER TABLE "hf_budget_period" ALTER COLUMN "spent_usd" SET DATA TYPE numeric(12, 6);--> statement-breakpoint
ALTER TABLE "hf_budget_period" ALTER COLUMN "spent_usd" SET DEFAULT '0';--> statement-breakpoint
-- Hand-written: the repair of what the narrow column already rounded away. Every settle is
-- `spent_usd = spent_usd + cost_usd` in the same transaction that writes the `ok` row, and
-- nothing else ever writes the column, so a period's `spent_usd` is by design exactly the sum
-- of its `ok` rows' `cost_usd`. At scale 4 each of those N additions rounded the running total,
-- so the stored value can sit up to N × 0.00005 away from that sum.
--
-- Only rows inside that bound are repaired. A row further out is drift this migration cannot
-- attribute to rounding, and `reconcile()` reports drift and never corrects it — a counter this
-- migration silently rewrote would hide exactly what that rule exists to surface.
UPDATE "hf_budget_period" b
SET "spent_usd" = l.ledger
FROM (
	SELECT "period", COALESCE(SUM("cost_usd"), 0) AS ledger, count(*) AS settled
	FROM "hf_llm_call" WHERE "status" = 'ok' GROUP BY "period"
) l
WHERE l."period" = b."period"
	AND b."spent_usd" <> l.ledger
	AND abs(b."spent_usd" - l.ledger) <= 0.00005 * l.settled;
