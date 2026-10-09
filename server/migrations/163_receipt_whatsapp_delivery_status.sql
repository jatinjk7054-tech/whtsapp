-- Per-receipt WhatsApp delivery status.
--
-- `receipts.sent` records that a user pressed Send. It is NOT evidence that the
-- donor got the PDF. Meta's /messages call returns 200 with a wamid the moment
-- it accepts the request; it downloads the receipt PDF afterwards, and that
-- second step is where a template send dies (error 131053, "Downloading media
-- from weblink failed with http code 403" when the S3 bucket stopped serving
-- anonymous reads). The real verdict arrives minutes later on the status
-- webhook, so it has to live somewhere the receipts list can read it.
--
-- Storing it on the receipt itself — not only on `messages` — matters because
-- recordReceiptInConversation() only writes a `messages` row when the donor
-- already has a WhatsApp conversation. A receipt to a donor who has never
-- messaged the NGO has no message row to hang the failure on, which is exactly
-- how 5 sends died invisibly while the UI showed them as sent.
--
-- wa_status mirrors Meta's own vocabulary: accepted | sent | delivered | read |
-- failed. `accepted` is what we write the moment /messages returns 200; it is
-- deliberately distinct from `sent` so "we asked Meta" and "Meta took it" are
-- never conflated.

ALTER TABLE receipts
  ADD COLUMN IF NOT EXISTS wa_message_id     TEXT,
  ADD COLUMN IF NOT EXISTS wa_status         TEXT,
  ADD COLUMN IF NOT EXISTS wa_failure_reason TEXT,
  ADD COLUMN IF NOT EXISTS wa_status_at      TIMESTAMPTZ;

-- The status webhook resolves a receipt by wamid on every single status frame
-- (sent -> delivered -> read is three lookups per message). Without this the
-- webhook sequentially scans the whole receipts table, and receipts is the
-- largest table the Accounts panel touches.
CREATE INDEX IF NOT EXISTS idx_receipts_wa_message_id
  ON receipts (wa_message_id)
  WHERE wa_message_id IS NOT NULL;
