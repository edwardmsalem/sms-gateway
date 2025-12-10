/**
 * Verification Code Watch Module
 * Monitors for verification codes from multiple services:
 * - Email: MLB, Ticketmaster, SeatGeek, Google, AXS
 * - SMS: Ticketmaster, MLB, AXS, Google
 */

const { google } = require('googleapis');
const db = require('./database');
const monday = require('./monday');
const simbank = require('./simbank');
const textchest = require('./textchest');
const { normalizePhone, formatPhoneDisplay } = require('./utils');

// ============================================================================
// MESSAGE TEMPLATES - Plain, clear responses
// ============================================================================

const MESSAGES = {
  watchStart: [
    (email) => `Watching ${email} for 10 minutes.`,
  ],
  foundNumber: [
    (num) => `Found ${num}. Activating...`,
  ],
  activated: [
    (slot) => `Slot ${slot} activated.`,
  ],
  codeFound: [
    (code, service) => `*${code}*${service ? ` (${service})` : ''}`,
  ],
  watchCompleteSuccess: [
    () => `Watch complete.`,
  ],
  watchCompleteEmpty: [
    () => `Watch complete. No codes found. Issues? Ping <@U0144K906KA>.`,
  ],
  notFound: [
    (email) => `${email} not found. Watching Gmail only.`,
  ],
  searching: [
    () => `Searching...`,
  ],
  activationFailed: [
    () => `SIM activation failed. Still watching Gmail.`,
  ],
};

// Track last used message index per category to avoid repetition
const lastUsedIndex = {};

/**
 * Get a random message from a category, avoiding the last used one
 */
function getMessage(category, ...args) {
  const messages = MESSAGES[category];
  if (!messages || messages.length === 0) return '';

  let index;
  if (messages.length === 1) {
    index = 0;
  } else {
    do {
      index = Math.floor(Math.random() * messages.length);
    } while (index === lastUsedIndex[category]);
  }

  lastUsedIndex[category] = index;
  return messages[index](...args);
}

// ============================================================================
// MODULE CODE
// ============================================================================

// Gmail client (lazily initialized)
let gmail = null;

/**
 * Initialize Gmail client for Ticketmaster (separate account from Maxsip)
 */
function getGmailClient() {
  if (gmail) return gmail;

  // Use TM_GMAIL_* env vars (separate from Maxsip Gmail)
  if (!process.env.TM_GMAIL_CLIENT_ID || !process.env.TM_GMAIL_CLIENT_SECRET || !process.env.TM_GMAIL_REFRESH_TOKEN) {
    return null;
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.TM_GMAIL_CLIENT_ID,
    process.env.TM_GMAIL_CLIENT_SECRET
  );

  oauth2Client.setCredentials({
    refresh_token: process.env.TM_GMAIL_REFRESH_TOKEN
  });

  gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  return gmail;
}

// Active watches: Map<normalizedPhone, { endTime, threadTs, slackChannel, source: 'ejoin'|'textchest' }>
const activeWatches = new Map();

// Watch duration: 10 minutes
const WATCH_DURATION_MS = 10 * 60 * 1000;

// Polling interval: 10 seconds (more responsive for codes)
const POLL_INTERVAL_MS = 10 * 1000;

/**
 * Check if a phone number has an active watch
 */
function hasActiveWatch(phone) {
  const normalized = normalizePhone(phone);
  const watch = activeWatches.get(normalized);
  if (!watch) return false;

  // Check if watch has expired
  if (Date.now() > watch.endTime) {
    activeWatches.delete(normalized);
    return false;
  }

  return true;
}

/**
 * Get active watch for a phone number
 */
function getActiveWatch(phone) {
  const normalized = normalizePhone(phone);
  const watch = activeWatches.get(normalized);
  if (!watch) return null;

  // Check if watch has expired
  if (Date.now() > watch.endTime) {
    activeWatches.delete(normalized);
    return null;
  }

  return watch;
}

/**
 * Post a message to a Slack thread
 */
async function postToThread(slackApp, channel, threadTs, message) {
  await slackApp.client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: message
  });
}

/**
 * Check if SMS message contains a verification code from supported services
 * Returns { isMatch: boolean, service: string|null, code: string|null }
 */
function parseVerificationSMS(content) {
  const text = content.toLowerCase();

  // Ticketmaster
  if (text.includes('ticketmaster')) {
    const codeMatch = content.match(/(\d{6})/);
    return { isMatch: true, service: 'Ticketmaster', code: codeMatch ? codeMatch[1] : null };
  }

  // MLB: "Your MLB verification code is: 010885."
  if (text.includes('mlb')) {
    const codeMatch = content.match(/verification code[:\s]*(\d{6})/i);
    return { isMatch: true, service: 'MLB', code: codeMatch ? codeMatch[1] : null };
  }

  // AXS: "Your AXS verification code is: 481455"
  if (text.includes('axs')) {
    const codeMatch = content.match(/verification code[:\s]*(\d{6})/i);
    return { isMatch: true, service: 'AXS', code: codeMatch ? codeMatch[1] : null };
  }

  // Google: "G-123456 is your Google verification code"
  const googleMatch = content.match(/G-(\d{6})/i);
  if (googleMatch) {
    return { isMatch: true, service: 'Google', code: googleMatch[1] };
  }

  // Generic fallback for other services
  if (text.includes('verification code') || text.includes('security code')) {
    const codeMatch = content.match(/code[:\s]*(\d{6})/i);
    return { isMatch: true, service: null, code: codeMatch ? codeMatch[1] : null };
  }

  return { isMatch: false, service: null, code: null };
}

/**
 * Check if message contains Ticketmaster code (legacy compatibility)
 */
function isTicketmasterMessage(content) {
  return content.toLowerCase().includes('ticketmaster');
}

/**
 * Format message age as human-readable string
 */
function formatMessageAge(timestampMs) {
  const ageMs = Date.now() - timestampMs;
  const ageMinutes = Math.floor(ageMs / 60000);
  const ageHours = Math.floor(ageMinutes / 60);

  if (ageMinutes < 1) return 'just now';
  if (ageMinutes < 60) return `${ageMinutes} minute${ageMinutes === 1 ? '' : 's'} ago`;
  if (ageHours < 24) return `${ageHours} hour${ageHours === 1 ? '' : 's'} ago`;
  const ageDays = Math.floor(ageHours / 24);
  return `${ageDays} day${ageDays === 1 ? '' : 's'} ago`;
}

/**
 * Start Textchest polling for a watch
 */
async function startTextchestPolling(slackApp, watch, number) {
  // Only show messages from last 1 hour (in milliseconds)
  const ONE_HOUR_MS = 60 * 60 * 1000;

  const pollInterval = setInterval(async () => {
    // Check if watch is still active
    if (Date.now() > watch.endTime) {
      clearInterval(pollInterval);
      const endMsg = watch.codesDelivered
        ? getMessage('watchCompleteSuccess')
        : getMessage('watchCompleteEmpty');
      await postToThread(slackApp, watch.slackChannel, watch.threadTs, endMsg);
      activeWatches.delete(normalizePhone(number));
      return;
    }

    try {
      // Get recent messages (ts=0 gets all, we filter by age)
      const messages = await textchest.getMessages(number, 100, 0);

      console.log(`[TM WATCH] Textchest poll: ${messages.length} messages for ${number}`);

      // Filter for Ticketmaster messages from last 1 hour
      const now = Date.now();
      const recentTmMessages = messages
        .filter(msg => {
          const content = msg.msg || msg.body || msg.message || msg.content || '';
          if (!isTicketmasterMessage(content)) return false;

          // Textchest ts is in milliseconds
          const msgTime = msg.ts || 0;
          const ageMs = now - msgTime;
          return ageMs <= ONE_HOUR_MS;
        })
        .sort((a, b) => (b.ts || 0) - (a.ts || 0)); // Sort newest first

      for (const msg of recentTmMessages) {
        const content = msg.msg || msg.body || msg.message || msg.content || '';
        const msgTime = msg.ts || 0;
        const ageText = formatMessageAge(msgTime);

        console.log(`[TM WATCH] TM message from ${msg.from}: "${content.substring(0, 50)}..." (${ageText})`);

        // Check if we've already posted this message
        if (!watch.postedMessages) watch.postedMessages = new Set();
        const msgKey = `${msg.ts || content.substring(0, 50)}`;

        if (!watch.postedMessages.has(msgKey)) {
          watch.postedMessages.add(msgKey);
          watch.codesDelivered = true;
          // Extract 6-digit code if present
          const codeMatch = content.match(/\d{6}/);
          const code = codeMatch ? codeMatch[0] : content;
          await postToThread(slackApp, watch.slackChannel, watch.threadTs,
            getMessage('codeFound', code));
        }
      }
    } catch (err) {
      console.error('[TM WATCH] Textchest poll error:', err.message);
    }
  }, POLL_INTERVAL_MS);

  // Store interval reference for cleanup
  watch.pollInterval = pollInterval;
}

/**
 * Handle inbound SMS that might match an active watch
 * Called from webhook.js when a message arrives
 * @param {string} recipientPhone - The receiving phone number (our SIM)
 * @param {string} senderPhone - The sender's phone number
 * @param {string} content - Message content
 * @param {object} slackApp - Slack app instance for posting
 */
async function checkWatchAndNotify(recipientPhone, senderPhone, content, slackApp) {
  const watch = getActiveWatch(recipientPhone);
  if (!watch) return false;

  // Parse for any verification SMS (Ticketmaster, MLB, AXS, Google, etc.)
  const parsed = parseVerificationSMS(content);
  if (!parsed.isMatch) return false;

  // Post to the watch thread
  try {
    watch.codesDelivered = true;
    const code = parsed.code || content;
    await postToThread(slackApp, watch.slackChannel, watch.threadTs,
      getMessage('codeFound', code, parsed.service));
    console.log(`[CODE WATCH] ${parsed.service || 'Verification'} code detected for ${recipientPhone}: ${code}`);
    return true;
  } catch (err) {
    console.error('[CODE WATCH] Failed to post code notification:', err.message);
    return false;
  }
}

/**
 * Clean up expired watches
 */
function cleanupExpiredWatches() {
  const now = Date.now();
  for (const [phone, watch] of activeWatches) {
    if (now > watch.endTime) {
      if (watch.pollInterval) {
        clearInterval(watch.pollInterval);
      }
      activeWatches.delete(phone);
    }
  }
}

// Run cleanup every minute
setInterval(cleanupExpiredWatches, 60 * 1000);

/**
 * Detect which service sent an email based on From header
 * Returns { service: string, filterByEmail: boolean, isPasswordReset: boolean }
 */
function detectEmailService(from, subject) {
  const fromLower = from.toLowerCase();
  const subjectLower = subject.toLowerCase();
  const isPasswordReset = subjectLower.includes('password reset') ||
                          subjectLower.includes('reset password') ||
                          subjectLower.includes('change your') && subjectLower.includes('password');

  // MLB
  if (fromLower.includes('@mlb.com') || fromLower.includes('mlb.com')) {
    return { service: 'MLB', filterByEmail: true, isPasswordReset };
  }

  // AXS (email comes through icloud.com relay but subject/from contains axs)
  if (fromLower.includes('axs') || subjectLower.includes('axs')) {
    return { service: 'AXS', filterByEmail: true, isPasswordReset };
  }

  // SeatGeek
  if (fromLower.includes('@seatgeek.com') || fromLower.includes('seatgeek')) {
    return { service: 'SeatGeek', filterByEmail: true, isPasswordReset };
  }

  // Ticketmaster
  if (fromLower.includes('ticketmaster')) {
    return { service: 'Ticketmaster', filterByEmail: true, isPasswordReset };
  }

  // Google
  if (fromLower.includes('google.com') || fromLower.includes('accounts.google')) {
    return { service: 'Google', filterByEmail: true, isPasswordReset };
  }

  return { service: null, filterByEmail: true, isPasswordReset };
}

/**
 * Extract password reset link from email body
 * Returns the reset URL or null
 */
function extractResetLink(body, service) {
  // Service-specific reset link patterns
  const linkPatterns = {
    'MLB': [
      /href="(https:\/\/ids\.mlb\.com\/email\/verify[^"]+)"/i,
      /(https:\/\/ids\.mlb\.com\/email\/verify\S+)/i,
    ],
    'AXS': [
      /href="(https:\/\/www\.axs\.com\/new-password[^"]+)"/i,
      /(https:\/\/www\.axs\.com\/new-password\S+)/i,
    ],
    'SeatGeek': [
      /href="(https:\/\/seatgeek\.com\/change_password\/code\/[^"]+)"/i,
      /(https:\/\/seatgeek\.com\/change_password\/code\/\S+)/i,
      /<(https:\/\/seatgeek\.com\/change_password\/code\/[^>]+)>/i,  // Text format: <URL>
    ],
  };

  // Try service-specific patterns
  if (service && linkPatterns[service]) {
    for (const pattern of linkPatterns[service]) {
      const match = body.match(pattern);
      if (match) {
        // Clean up the URL (unescape HTML entities)
        return match[1].replace(/&amp;/g, '&');
      }
    }
  }

  // Generic reset link patterns
  const genericPatterns = [
    /href="(https?:\/\/[^"]*(?:reset|password|verify)[^"]+)"/i,
    /(https?:\/\/\S*(?:reset-password|new-password|verify)\S+)/i,
  ];

  for (const pattern of genericPatterns) {
    const match = body.match(pattern);
    if (match) {
      return match[1].replace(/&amp;/g, '&');
    }
  }

  return null;
}

/**
 * Extract verification code from email body
 * Returns { code: string|null }
 */
function extractCodeFromEmail(body, service) {
  // Service-specific patterns
  const servicePatterns = {
    'MLB': [
      /verification code is[:\s]*(?:<[^>]*>)?(\d{6})/i,
      /verification code[:\s]*(\d{6})/i,
    ],
    'SeatGeek': [
      />(\d{6})</,  // Code in styled div
      /verification code[\s\S]{0,100}?(\d{6})/i,
    ],
    'Ticketmaster': [
      /authentication\s*code[:\s]*(\d{6})/i,
      /reset\s*code[:\s]*(\d{6})/i,
    ],
    'Google': [
      /G-(\d{6})/i,
    ],
  };

  // Try service-specific patterns first
  if (service && servicePatterns[service]) {
    for (const pattern of servicePatterns[service]) {
      const match = body.match(pattern);
      if (match) return match[1];
    }
  }

  // Generic patterns that work for most services
  const genericPatterns = [
    /authentication\s*code[:\s]*(\d{6})/i,
    /reset\s*code[:\s]*(\d{6})/i,
    /security\s*code[:\s]*(\d{6})/i,
    /verification\s*code[:\s]*(\d{6})/i,
    /your\s*code[:\s]*(\d{6})/i,
    /code\s*is[:\s]*(\d{6})/i,
    />(\d{6})</,  // Code in HTML tags
  ];

  for (const pattern of genericPatterns) {
    const match = body.match(pattern);
    if (match) return match[1];
  }

  // Fallback: look for any 6-digit number after "code" keyword
  const fallbackMatch = body.match(/code[\s\S]{0,50}?(\d{6})/i);
  return fallbackMatch ? fallbackMatch[1] : null;
}

/**
 * Poll Gmail for verification emails from ALL services
 * Searches for: MLB, SeatGeek, Ticketmaster, Google, AXS
 * Handles both verification codes AND password reset links
 */
async function pollGmailForVerificationCodes(slackApp, watch, email) {
  const gmailClient = getGmailClient();
  if (!gmailClient) {
    console.log('[CODE WATCH] Gmail not configured, skipping email monitoring');
    return;
  }

  const pollInterval = setInterval(async () => {
    // Check if watch is still active
    if (Date.now() > watch.endTime) {
      clearInterval(pollInterval);
      return;
    }

    try {
      // Search for verification emails from ALL supported services
      // Query breakdown:
      // - Subject patterns for verification/security/authentication codes
      // - Subject patterns for password resets
      // - From known senders OR containing the target email
      // - Only last 1 hour
      const query = `(subject:"security code" OR subject:"verification code" OR subject:"authentication code" OR subject:"reset password" OR subject:"password reset" OR subject:"change your" OR subject:"sign in" OR subject:"sign into") newer_than:1h`;

      const response = await gmailClient.users.messages.list({
        userId: 'me',
        q: query,
        maxResults: 20
      });

      const messages = response.data.messages || [];
      console.log(`[CODE WATCH] Gmail poll: ${messages.length} verification emails found`);

      for (const msg of messages) {
        // Skip if already posted
        if (!watch.postedEmails) watch.postedEmails = new Set();
        if (watch.postedEmails.has(msg.id)) continue;

        // Get email content
        const fullMessage = await gmailClient.users.messages.get({
          userId: 'me',
          id: msg.id,
          format: 'full'
        });

        const headers = fullMessage.data.payload.headers;
        const subject = headers.find(h => h.name.toLowerCase() === 'subject')?.value || 'No subject';
        const from = headers.find(h => h.name.toLowerCase() === 'from')?.value || 'Unknown';
        const to = headers.find(h => h.name.toLowerCase() === 'to')?.value || '';
        const deliveredTo = headers.find(h => h.name.toLowerCase() === 'delivered-to')?.value || '';

        // Detect service
        const { service, filterByEmail, isPasswordReset } = detectEmailService(from, subject);

        // Check if email matches target (unless service doesn't filter)
        const emailLower = email.toLowerCase();
        const emailMatches = !filterByEmail ||
          to.toLowerCase().includes(emailLower) ||
          deliveredTo.toLowerCase().includes(emailLower) ||
          subject.toLowerCase().includes(emailLower);

        if (!emailMatches) {
          console.log(`[CODE WATCH] Skipping ${service || 'unknown'} email - doesn't match ${email}`);
          continue;
        }

        // Extract body (handle multipart) - prefer HTML for reset links
        let body = '';
        let htmlBody = '';
        const payload = fullMessage.data.payload;
        if (payload.body?.data) {
          body = Buffer.from(payload.body.data, 'base64').toString('utf8');
          htmlBody = body;
        } else if (payload.parts) {
          const textPart = payload.parts.find(p => p.mimeType === 'text/plain');
          const htmlPart = payload.parts.find(p => p.mimeType === 'text/html');
          if (textPart?.body?.data) {
            body = Buffer.from(textPart.body.data, 'base64').toString('utf8');
          }
          if (htmlPart?.body?.data) {
            htmlBody = Buffer.from(htmlPart.body.data, 'base64').toString('utf8');
          }
        }

        watch.postedEmails.add(msg.id);

        // Handle password reset emails (extract link)
        if (isPasswordReset) {
          const resetLink = extractResetLink(htmlBody || body, service);
          if (resetLink) {
            watch.codesDelivered = true;
            await postToThread(slackApp, watch.slackChannel, watch.threadTs,
              `🔗 *${service} Password Reset*\n${resetLink}`);
            console.log(`[CODE WATCH] Found ${service} reset link`);
          }
        } else {
          // Handle verification code emails
          const code = extractCodeFromEmail(body || htmlBody, service);

          if (code) {
            watch.codesDelivered = true;
            await postToThread(slackApp, watch.slackChannel, watch.threadTs,
              getMessage('codeFound', code, service));
            console.log(`[CODE WATCH] Found ${service || 'unknown'} code: ${code}`);
          }
        }

        // Mark as read
        await gmailClient.users.messages.modify({
          userId: 'me',
          id: msg.id,
          requestBody: { removeLabelIds: ['UNREAD'] }
        });
      }
    } catch (err) {
      console.error('[CODE WATCH] Gmail poll error:', err.message);
    }
  }, POLL_INTERVAL_MS);

  // Store interval reference
  watch.gmailPollInterval = pollInterval;
}

// Keep old function name for compatibility
const pollGmailForTicketmaster = pollGmailForVerificationCodes;

/**
 * Start a verification code watch
 * Monitors: Gmail (all verification services) + SMS (Textchest/SIM banks)
 * @param {object} slackApp - Slack Bolt app instance
 * @param {string} email - Email address to search for
 * @param {string} slackChannel - Slack channel ID
 * @param {string} threadTs - Thread timestamp for replies
 */
async function startTextchestWatch(slackApp, email, slackChannel, threadTs) {
  try {
    let smsSource = null;
    let phoneDisplay = null;
    let watchKey = email;
    let slotId = null;

    // Step 1: Try Textchest for SMS
    const textchestNumber = await textchest.findNumberByEmail(email);

    if (textchestNumber) {
      phoneDisplay = formatPhoneDisplay(textchestNumber.number);
      smsSource = 'textchest';
      watchKey = normalizePhone(textchestNumber.number);

      await postToThread(slackApp, slackChannel, threadTs,
        getMessage('foundNumber', phoneDisplay));

      // Activate Textchest SIM
      try {
        const activateResult = await textchest.activateSim(textchestNumber.number);
        slotId = activateResult.slot;
        await postToThread(slackApp, slackChannel, threadTs,
          getMessage('activated', slotId));
      } catch (err) {
        await postToThread(slackApp, slackChannel, threadTs,
          getMessage('activationFailed'));
      }
    } else {
      // Step 2: Try Monday.com for SS number (Associates board)
      await postToThread(slackApp, slackChannel, threadTs,
        `Not in Textchest. Checking Monday.com...`);

      let foundRecord = await monday.searchAssociateByEmail(email);
      let recordSource = 'associate';

      // Step 3: If not in Associates, try External Emails board
      if (!foundRecord) {
        foundRecord = await monday.searchExternalByEmail(email);
        recordSource = 'external';
      }

      if (foundRecord) {
        phoneDisplay = formatPhoneDisplay(foundRecord.phone);

        const sourceLabel = recordSource === 'associate'
          ? `Found ${foundRecord.name} · ${phoneDisplay}`
          : `Found external: ${phoneDisplay}`;
        await postToThread(slackApp, slackChannel, threadTs,
          `${sourceLabel}. Searching SIM banks...`);

        // Query SIM banks directly to find which slot has this number
        const slotInfo = await simbank.findSlotByPhone(foundRecord.phone);

        if (slotInfo) {
          smsSource = 'ss';
          watchKey = normalizePhone(foundRecord.phone);
          slotId = `${slotInfo.bankId}-${slotInfo.slot}`;

          await postToThread(slackApp, slackChannel, threadTs,
            getMessage('foundNumber', phoneDisplay));

          // Activate slot
          const bank = db.getSimBank(slotInfo.bankId);
          if (bank) {
            try {
              await simbank.activateSlot(bank, slotInfo.slot);
              await postToThread(slackApp, slackChannel, threadTs,
                getMessage('activated', slotInfo.slot));
            } catch (err) {
              await postToThread(slackApp, slackChannel, threadTs,
                getMessage('activationFailed'));
            }
          }
        }
      } else {
        await postToThread(slackApp, slackChannel, threadTs,
          `Not found in Monday.com. Watching Gmail only.`);
      }
    }

    // Create watch - always proceed even without SMS source (email-only watch)
    const watch = {
      endTime: Date.now() + WATCH_DURATION_MS,
      threadTs,
      slackChannel,
      source: smsSource || 'email-only',
      email,
      postedMessages: new Set(),
      postedEmails: new Set(),
      codesDelivered: false
    };
    activeWatches.set(watchKey, watch);

    // Start SMS polling if Textchest
    if (smsSource === 'textchest' && textchestNumber) {
      await startTextchestPolling(slackApp, watch, textchestNumber.number);
    }

    // Start Gmail polling for all verification services
    pollGmailForVerificationCodes(slackApp, watch, email);

    // Opening line
    await postToThread(slackApp, slackChannel, threadTs,
      getMessage('watchStart', email));

    // Set cleanup timer
    setTimeout(() => {
      const w = activeWatches.get(watchKey);
      if (w && Date.now() >= w.endTime) {
        if (w.pollInterval) clearInterval(w.pollInterval);
        if (w.gmailPollInterval) clearInterval(w.gmailPollInterval);
        activeWatches.delete(watchKey);
        const endMsg = w.codesDelivered
          ? getMessage('watchCompleteSuccess')
          : getMessage('watchCompleteEmpty');
        postToThread(slackApp, slackChannel, threadTs, endMsg).catch(console.error);
      }
    }, WATCH_DURATION_MS);

    console.log(`[CODE WATCH] Started watch for ${email}: SMS=${smsSource || 'none'}, Gmail=yes`);

  } catch (error) {
    console.error('[CODE WATCH] Error:', error.message);
    await postToThread(slackApp, slackChannel, threadTs,
      `❌ Error: ${error.message}`);
  }
}

module.exports = {
  startTextchestWatch,
  checkWatchAndNotify,
  hasActiveWatch,
  getActiveWatch,
  parseVerificationSMS
};
