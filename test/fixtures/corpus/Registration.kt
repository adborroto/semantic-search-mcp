package com.example.engagement

/**
 * Registers a follow between two accounts. Duplicate follows are idempotent:
 * the second call is a no-op rather than an error.
 */
class RegistrationHandler(private val repository: FollowRepository) {
    fun register(followerId: Long, followeeId: Long) {
        repository.upsert(followerId, followeeId)
    }
}
