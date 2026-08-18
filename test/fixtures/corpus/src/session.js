export function createSession(user) {
  return { userId: user.id, issuedAt: Date.now(), ttlSeconds: 3600 };
}
