# Retry and backoff

When a request to the payment provider fails with a 5xx, the client retries with
exponential backoff: it waits 200ms, then 400ms, then 800ms, giving up after four
attempts. Jitter is added to avoid a thundering herd when many clients recover at
the same moment.

Idempotency keys make the retry safe: replaying the same charge with the same key
returns the original result instead of double-charging the customer.
