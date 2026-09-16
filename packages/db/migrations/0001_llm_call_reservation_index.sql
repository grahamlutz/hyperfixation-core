CREATE INDEX "hf_llm_call_reservation_idx"
  ON "hf_llm_call" USING btree ("period", "run_id", "workflow_id")
  INCLUDE ("estimated_cost_usd")
  WHERE "status" = 'started';
