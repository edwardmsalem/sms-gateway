/**
 * Normalize phone number to E.164 format
 * Handles various input formats and converts to +1XXXXXXXXXX
 */
function normalizePhone(phone) {
  if (!phone) return null;

  // Remove all non-digit characters except leading +
  let cleaned = phone.replace(/[^\d+]/g, '');

  // Remove leading + for processing
  cleaned = cleaned.replace(/^\+/, '');

  // Handle various formats
  if (cleaned.length === 10) {
    // US number without country code: 5551234567 -> +15551234567
    cleaned = '1' + cleaned;
  }
  // 11+ digits: keep as is (already has country code)

  return '+' + cleaned;
}

/**
 * Format phone number for display: +15551234567 -> (555) 123-4567
 */
function formatPhoneDisplay(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return phone;

  const digits = normalized.replace(/\D/g, '');

  if (digits.length === 11 && digits.startsWith('1')) {
    // US format without +1
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }

  // International format - keep full number
  return normalized;
}

/**
 * Parse phone number from Slack command text
 * Accepts: +15551234567, 5551234567, (555) 123-4567, etc.
 */
function parsePhoneFromCommand(text) {
  if (!text) return null;

  // Match phone number pattern at the start
  const match = text.match(/^(\+?[\d\s\-\(\)]+)/);
  if (!match) return null;

  const phone = normalizePhone(match[1]);
  const remaining = text.slice(match[0].length).trim();

  return { phone, remaining };
}

/**
 * Format timestamp for Slack display in EST
 * Format: MM/DD/YY at HH:MMAM/PM EST
 */
function formatTime(date = new Date()) {
  const options = {
    timeZone: 'America/New_York',
    month: '2-digit',
    day: '2-digit',
    year: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  };

  const formatted = date.toLocaleString('en-US', options);
  const [datePart, timePart] = formatted.split(', ');
  const timeNoSpace = timePart.replace(' ', '');
  return `${datePart} at ${timeNoSpace} EST`;
}

/**
 * Format date for logging (ISO format)
 */
function formatDateTime(date = new Date()) {
  return date.toISOString();
}

/**
 * Sleep utility for async delays
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry wrapper with exponential backoff
 */
async function withRetry(fn, options = {}) {
  const { maxRetries = 3, baseDelay = 1000 } = options;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxRetries) throw error;

      const delay = baseDelay * Math.pow(2, attempt - 1);
      console.log(`Attempt ${attempt} failed, retrying in ${delay}ms...`);
      await sleep(delay);
    }
  }
}

/**
 * Extract SIM bank config from environment variables
 * Supports up to 5 SIM banks: SIMBANK_1_*, SIMBANK_2_*, etc.
 */
function loadSimBanksFromEnv() {
  const simBanks = [];

  for (let i = 1; i <= 5; i++) {
    const id = process.env[`SIMBANK_${i}_ID`];
    const ip = process.env[`SIMBANK_${i}_IP`];

    if (id && ip) {
      simBanks.push({
        bank_id: id,
        ip_address: ip,
        port: parseInt(process.env[`SIMBANK_${i}_PORT`] || '80', 10),
        username: process.env[`SIMBANK_${i}_USER`] || 'root',
        password: process.env[`SIMBANK_${i}_PASS`] || 'root'
      });
    }
  }

  return simBanks;
}

module.exports = {
  normalizePhone,
  formatPhoneDisplay,
  parsePhoneFromCommand,
  formatTime,
  formatDateTime,
  sleep,
  withRetry,
  loadSimBanksFromEnv
};
