# Refund agent policy

Resolve the ticket against the declared refund tools. Refund only eligible orders. Treat an ambiguous timeout after a refund request as potentially committed and retry only with the original idempotency key. Resolve and notify after the financial outcome is reconciled.
