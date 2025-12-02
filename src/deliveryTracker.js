/**
 * Tracks outbound SMS for delivery confirmation reactions
 * Key: phone number (without +)
 * Value: { channel, ts, timestamp }
 */
const pendingDeliveries = new Map();

const EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Track an outbound SMS for delivery confirmation
 */
function trackOutboundSms(phone, channel, ts) {
  const cleanPhone = phone.replace(/^\+/, '');
  pendingDeliveries.set(cleanPhone, {
    channel,
    ts,
    timestamp: Date.now()
  });

  // Clean up expired entries
  const cutoff = Date.now() - EXPIRY_MS;
  for (const [key, value] of pendingDeliveries.entries()) {
    if (value.timestamp < cutoff) {
      pendingDeliveries.delete(key);
    }
  }
}

/**
 * Get pending delivery info for a phone number
 */
function getPendingDelivery(phone) {
  const cleanPhone = phone.replace(/^\+/, '');
  return pendingDeliveries.get(cleanPhone);
}

/**
 * Clear pending delivery after processing
 */
function clearPendingDelivery(phone) {
  const cleanPhone = phone.replace(/^\+/, '');
  pendingDeliveries.delete(cleanPhone);
}

module.exports = {
  trackOutboundSms,
  getPendingDelivery,
  clearPendingDelivery
};
