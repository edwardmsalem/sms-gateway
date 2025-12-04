/**
 * Textchest API Client
 * https://api.textchest.com
 */

const BASE_URL = 'https://api.textchest.com';

/**
 * Get authorization header (Basic auth with API key)
 */
function getAuthHeader() {
  const apiKey = process.env.TEXTCHEST_API_KEY;
  if (!apiKey) {
    throw new Error('TEXTCHEST_API_KEY environment variable is not set');
  }
  // Base64 encode "apiKey:" for Basic auth
  const encoded = Buffer.from(apiKey + ':').toString('base64');
  return `Basic ${encoded}`;
}

/**
 * Get all numbers from Textchest
 * @param {number} limit - Max numbers to return (default 2000 to cover large inventories)
 * @returns {Promise<Array<{number: string, tags: string[], email: string, module_uuid: string, slot: string}>>}
 */
async function getNumbers(limit = 2000) {
  const params = new URLSearchParams({
    async_inbox: 'true',
    limit: limit.toString()
  });

  const response = await fetch(`${BASE_URL}/numbers?${params}`, {
    method: 'GET',
    headers: {
      'Authorization': getAuthHeader()
    }
  });

  if (!response.ok) {
    throw new Error(`Textchest API returned HTTP ${response.status}`);
  }

  return response.json();
}

/**
 * Get SMS messages for a number
 * @param {string} number - Phone number
 * @param {number} limit - Max messages to return (default 100)
 * @param {number} ts - Only return messages after this timestamp (default 0)
 * @returns {Promise<Array<{msg: string, ts: number, from: string}>>}
 */
async function getMessages(number, limit = 100, ts = 0) {
  const params = new URLSearchParams({
    async_inbox: 'true',
    number,
    limit: limit.toString(),
    ts: ts.toString()
  });

  const response = await fetch(`${BASE_URL}/sms?${params}`, {
    method: 'GET',
    headers: {
      'Authorization': getAuthHeader()
    }
  });

  if (!response.ok) {
    throw new Error(`Textchest API returned HTTP ${response.status}`);
  }

  return response.json();
}

/**
 * Activate a SIM number
 * Must be called before using a number to receive SMS
 * @param {string} number - Phone number to activate
 * @returns {Promise<{number: string, slot: string, next_number: string, module_uuid: string}>}
 */
async function activateSim(number) {
  const params = new URLSearchParams({
    number: number.toString().replace(/\D/g, '')
  });

  const response = await fetch(`${BASE_URL}/activate?${params}`, {
    method: 'GET',
    headers: {
      'Authorization': getAuthHeader()
    }
  });

  if (!response.ok) {
    throw new Error(`Textchest activate API returned HTTP ${response.status}`);
  }

  return response.json();
}

/**
 * Find a number by email (case-insensitive)
 * @param {string} email - Email to search for
 * @returns {Promise<{number: string, tags: string[], email: string}|null>}
 */
async function findNumberByEmail(email) {
  const numbers = await getNumbers();
  const normalizedEmail = email.toLowerCase().trim();

  console.log(`[TEXTCHEST] Searching for email: ${normalizedEmail}`);
  console.log(`[TEXTCHEST] Found ${numbers.length} numbers`);

  // Log first few numbers to debug field names
  if (numbers.length > 0) {
    console.log(`[TEXTCHEST] Sample number fields:`, Object.keys(numbers[0]));
  }

  const match = numbers.find(n => {
    const numEmail = n.email || n.Email || n.EMAIL || '';
    return numEmail.toLowerCase().trim() === normalizedEmail;
  });

  if (match) {
    console.log(`[TEXTCHEST] Found match:`, match.number || match.Number);
  } else {
    // Log numbers that have similar emails for debugging
    const similar = numbers.filter(n => {
      const numEmail = (n.email || n.Email || n.EMAIL || '').toLowerCase();
      return numEmail.includes(normalizedEmail.split('@')[0]);
    });
    if (similar.length > 0) {
      console.log(`[TEXTCHEST] Similar emails found:`, similar.map(n => n.email || n.Email || n.EMAIL));
    }
  }

  return match || null;
}

module.exports = {
  getNumbers,
  getMessages,
  activateSim,
  findNumberByEmail
};
