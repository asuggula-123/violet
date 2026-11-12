-- P4: an approval requested inside a tainted Brain turn may carry third-party text in its
-- prompt. Its deliveries and resolver lines are stored tainted, and the Brain sees it only as
-- untrusted data. Approvals still pending now are marked tainted (fail closed: their turn's
-- taint was never recorded).
ALTER TABLE approvals ADD COLUMN tainted boolean NOT NULL DEFAULT false;
UPDATE approvals SET tainted = true WHERE status = 'pending';
