---
"@hyperfixation/testing": patch
---

New `waitForWorkflowStatus(pool, workflowId, status, options)`, the `dbos.workflow_status`
sibling of `waitForRun`. Every `hf_run` status the flow wrapper writes is committed from inside
the workflow body, so DBOS records the attempt's terminal status only after the body returns: a
test that reads the DBOS row once, the moment `hf_run` settles, is reading it inside that gap.
Like `waitForRun` it prints the last row it saw when it times out, as `WorkflowNeverMatched`.
