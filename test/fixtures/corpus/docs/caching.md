# Cache invalidation

The read-through cache stores rendered article pages for fifteen minutes. Writes
invalidate the entry immediately by publishing a domain event, so a stale article
is never served to a reader after an update.
