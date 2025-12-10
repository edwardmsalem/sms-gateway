/**
 * Verification Code Scanner
 * Scans Slack channel for forwarded verification emails and extracts codes
 *
 * Supports: Microsoft/Outlook, MLB, SeatGeek, Ticketmaster, and more
 */

// Verification channel where forwarded emails arrive
const VERIFICATION_CHANNEL_ID = 'C05KCUMN35M';

// How far back to search for codes (1 hour in seconds)
const MAX_MESSAGE_AGE_SECONDS = 60 * 60;

/**
 * Service definitions with detection and extraction patterns
 */
const SERVICES = {
  microsoft: {
    name: 'Microsoft',
    // Detect by From header containing microsoft
    detectFrom: /accountprotection\.microsoft\.com|microsoft\.com/i,
    // Microsoft: Don't filter by email - get ALL codes
    filterByEmail: false,
    // Extract code pattern
    codePatterns: [
      /Security code:\s*(\d{6})/i,
      /security code is[:\s]*(\d{6})/i,
      /verification code[:\s]*(\d{6})/i,
    ],
  },
  ticketmaster: {
    name: 'Ticketmaster',
    detectFrom: /ticketmaster\.com/i,
    filterByEmail: true,
    codePatterns: [
      /Authentication Code[:\s]*(\d{6})/i,
      /Reset Code[:\s]*(\d{6})/i,
      /Your Code[:\s]*(\d{6})/i,
      /Verification Code[:\s]*(\d{6})/i,
      /Code is[:\s]*(\d{6})/i,
    ],
  },
  mlb: {
    name: 'MLB',
    detectFrom: /@mlb\.com/i,
    filterByEmail: true,
    codePatterns: [
      /verification code is[:\s]*(?:<[^>]*>)?(\d{6})/i,
      /verification code[:\s]*(\d{6})/i,
    ],
  },
  seatgeek: {
    name: 'SeatGeek',
    detectFrom: /@seatgeek\.com/i,
    filterByEmail: true,
    codePatterns: [
      // SeatGeek puts code on its own line or in styled div
      /verification code[\s\S]{0,100}?(\d{6})/i,
      // Fallback: standalone 6-digit in the code section
      />(\d{6})</,
    ],
  },
  stubhub: {
    name: 'StubHub',
    detectFrom: /@stubhub\.com/i,
    filterByEmail: true,
    codePatterns: [
      /verification code[:\s]*(\d{6})/i,
      /security code[:\s]*(\d{6})/i,
    ],
  },
  vividseats: {
    name: 'Vivid Seats',
    detectFrom: /@vividseats\.com/i,
    filterByEmail: true,
    codePatterns: [
      /verification code[:\s]*(\d{6})/i,
      /security code[:\s]*(\d{6})/i,
    ],
  },
  google: {
    name: 'Google',
    detectFrom: /accounts\.google\.com|google\.com/i,
    filterByEmail: true,
    codePatterns: [
      /G-(\d{6})/i,
      /verification code[:\s]*(\d{6})/i,
    ],
  },
  axs: {
    name: 'AXS',
    detectFrom: /@axs\.com/i,
    // AXS: Don't filter by email - show ALL codes (can't match reliably)
    filterByEmail: false,
    codePatterns: [
      /verification code[:\s]*(\d{6})/i,
    ],
  },
};

/**
 * Parse email headers from raw email text
 */
function parseEmailHeaders(text) {
  const headers = {};

  // Extract To header
  const toMatch = text.match(/^To:\s*(.+)$/im);
  if (toMatch) {
    headers.to = toMatch[1].trim();
  }

  // Extract From header
  const fromMatch = text.match(/^From:\s*(.+)$/im);
  if (fromMatch) {
    headers.from = fromMatch[1].trim();
  }

  // Extract Subject header
  const subjectMatch = text.match(/^Subject:\s*(.+)$/im);
  if (subjectMatch) {
    headers.subject = subjectMatch[1].trim();
  }

  // Extract Delivered-To (often the actual recipient)
  const deliveredToMatch = text.match(/^Delivered-To:\s*(.+)$/im);
  if (deliveredToMatch) {
    headers.deliveredTo = deliveredToMatch[1].trim();
  }

  // Extract X-Forwarded-For (original recipient before forwarding)
  const forwardedForMatch = text.match(/^X-Forwarded-For:\s*(.+)$/im);
  if (forwardedForMatch) {
    headers.forwardedFor = forwardedForMatch[1].trim();
  }

  return headers;
}

/**
 * Detect which service sent an email
 */
function detectService(text) {
  const headers = parseEmailHeaders(text);

  for (const [key, service] of Object.entries(SERVICES)) {
    if (headers.from && service.detectFrom.test(headers.from)) {
      return { key, service, headers };
    }
  }

  // Fallback: check the entire text for service indicators
  for (const [key, service] of Object.entries(SERVICES)) {
    if (service.detectFrom.test(text)) {
      return { key, service, headers };
    }
  }

  return null;
}

/**
 * Extract verification code from email text using service-specific patterns
 */
function extractCode(text, service) {
  for (const pattern of service.codePatterns) {
    const match = text.match(pattern);
    if (match) {
      return match[1];
    }
  }

  // Fallback: look for any 6-digit code near keywords
  const fallbackMatch = text.match(/(?:code|verification|security)[\s\S]{0,50}?(\d{6})/i);
  if (fallbackMatch) {
    return fallbackMatch[1];
  }

  return null;
}

/**
 * Check if email matches the target email address
 */
function emailMatches(headers, targetEmail) {
  if (!targetEmail) return true;

  const normalizedTarget = targetEmail.toLowerCase().trim();

  // Check To header
  if (headers.to && headers.to.toLowerCase().includes(normalizedTarget)) {
    return true;
  }

  // Check Delivered-To header
  if (headers.deliveredTo && headers.deliveredTo.toLowerCase().includes(normalizedTarget)) {
    return true;
  }

  // Check X-Forwarded-For header
  if (headers.forwardedFor && headers.forwardedFor.toLowerCase().includes(normalizedTarget)) {
    return true;
  }

  return false;
}

/**
 * Scan the verification channel for codes matching an email
 * @param {object} slackClient - Slack WebClient instance
 * @param {string} email - Email address to search for (null = get all)
 * @param {object} options - Optional settings
 * @returns {Array} Array of found codes with metadata
 */
async function scanChannelForCodes(slackClient, email, options = {}) {
  const {
    maxAge = MAX_MESSAGE_AGE_SECONDS,
    limit = 100,
    includeAllMicrosoft = true,
  } = options;

  const results = [];
  const seenCodes = new Set();
  const cutoffTime = Math.floor(Date.now() / 1000) - maxAge;

  try {
    // Fetch recent messages from the verification channel
    const response = await slackClient.conversations.history({
      channel: VERIFICATION_CHANNEL_ID,
      limit,
    });

    const messages = response.messages || [];

    for (const msg of messages) {
      // Skip old messages
      const msgTime = parseFloat(msg.ts);
      if (msgTime < cutoffTime) {
        continue;
      }

      const text = msg.text || '';
      if (!text) continue;

      // Detect the service
      const detected = detectService(text);
      if (!detected) continue;

      const { key, service, headers } = detected;

      // Check if we should include this based on email filter
      let shouldInclude = false;

      if (key === 'microsoft' && includeAllMicrosoft) {
        // Always include Microsoft codes (user requested this)
        shouldInclude = true;
      } else if (!service.filterByEmail) {
        // Service doesn't require email filtering
        shouldInclude = true;
      } else if (emailMatches(headers, email)) {
        // Email matches the target
        shouldInclude = true;
      }

      if (!shouldInclude) continue;

      // Extract the code
      const code = extractCode(text, service);
      if (!code) continue;

      // Deduplicate codes
      const codeKey = `${service.name}:${code}`;
      if (seenCodes.has(codeKey)) continue;
      seenCodes.add(codeKey);

      results.push({
        code,
        service: service.name,
        serviceKey: key,
        email: headers.to || headers.deliveredTo || 'unknown',
        timestamp: msgTime,
        messageTs: msg.ts,
        // Flag codes that are shown to all watchers (not filtered by email)
        isSharedCode: !service.filterByEmail,
      });
    }

    // Sort by timestamp (newest first)
    results.sort((a, b) => b.timestamp - a.timestamp);

  } catch (error) {
    console.error('[VERIFICATION SCANNER] Error scanning channel:', error.message);
  }

  return results;
}

/**
 * Start watching the channel for new codes
 * @param {object} slackClient - Slack WebClient instance
 * @param {string} email - Email address to watch for
 * @param {function} onCodeFound - Callback when code is found
 * @param {object} options - Watch options
 * @returns {object} Watch controller with stop() method
 */
function startChannelWatch(slackClient, email, onCodeFound, options = {}) {
  const {
    pollInterval = 10000, // 10 seconds
    duration = 10 * 60 * 1000, // 10 minutes
    includeAllMicrosoft = true,
  } = options;

  const seenMessageTs = new Set();
  const startTime = Date.now();
  let stopped = false;

  const poll = async () => {
    if (stopped) return;
    if (Date.now() - startTime > duration) {
      stopped = true;
      return;
    }

    try {
      const codes = await scanChannelForCodes(slackClient, email, {
        maxAge: 300, // Only look at last 5 minutes for new codes during watch
        includeAllMicrosoft,
      });

      for (const result of codes) {
        if (!seenMessageTs.has(result.messageTs)) {
          seenMessageTs.add(result.messageTs);
          await onCodeFound(result);
        }
      }
    } catch (error) {
      console.error('[VERIFICATION SCANNER] Poll error:', error.message);
    }

    // Schedule next poll
    if (!stopped) {
      setTimeout(poll, pollInterval);
    }
  };

  // Initial poll
  poll();

  return {
    stop: () => {
      stopped = true;
    },
    isRunning: () => !stopped,
  };
}

module.exports = {
  scanChannelForCodes,
  startChannelWatch,
  parseEmailHeaders,
  detectService,
  extractCode,
  SERVICES,
  VERIFICATION_CHANNEL_ID,
};
