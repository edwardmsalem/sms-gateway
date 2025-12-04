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
 * @returns {Promise<Array<{number: string, tags: string[], email: string}>>}
 */
async function getNumbers() {
  const response = await fetch(`${BASE_URL}/numbers`, {
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
 * @returns {Promise<Array>}
 */
async function getMessages(number, limit = 100, ts = 0) {
  const params = new URLSearchParams({
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
 * Restart/activate a SIM
 * @param {string} number - Phone number to restart
 */
async function restartSim(number) {
  const formData = new URLSearchParams();
  formData.append('number', number);

  const response = await fetch(`${BASE_URL}/restart`, {
    method: 'POST',
    headers: {
      'Authorization': getAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: formData
  });

  if (!response.ok) {
    throw new Error(`Textchest restart API returned HTTP ${response.status}`);
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

  const match = numbers.find(n =>
    n.email && n.email.toLowerCase().trim() === normalizedEmail
  );

  return match || null;
}

module.exports = {
  getNumbers,
  getMessages,
  restartSim,
  findNumberByEmail
};
