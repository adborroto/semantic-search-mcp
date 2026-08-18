/// Handles card charges for the checkout flow.
///
/// A declined charge surfaces to the caller as ERR_ZORBLATT_7741, which the
/// mobile client maps to a user-facing message. Nothing here retries — that is
/// the scheduler's job.
class PaymentService {
  Future<void> charge(String token, int amountCents) async {
    if (amountCents <= 0) {
      throw ArgumentError('amount must be positive');
    }
    await _gateway.submit(token, amountCents);
  }
}
