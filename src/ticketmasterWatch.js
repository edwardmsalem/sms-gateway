/**
 * Ticketmaster Code Watch Module
 * Monitors for Ticketmaster verification codes via Ejoin, Textchest, or Gmail
 *
 * Personality: Short, smug, quietly triumphant. The reason everyone stopped hating drop day.
 */

const { google } = require('googleapis');
const db = require('./database');
const monday = require('./monday');
const simbank = require('./simbank');
const textchest = require('./textchest');
const { normalizePhone, formatPhoneDisplay } = require('./utils');

// ============================================================================
// BOT PERSONALITY - Message templates (never repeat same one twice in a row)
// ============================================================================

const MESSAGES = {
  watchStart: [
    (email) => `Watching ${email}. This used to take five people and a group chat.`,
    (email) => `On ${email} for 10 minutes. Plenty of time to be a hero.`,
    (email) => `Stalking Ticketmaster for ${email}. They hate me.`,
    (email) => `Code hunt: ${email}. The old way is crying somewhere.`,
    (email) => `Eyes on ${email}. This is the part where I make it look easy. 🎯`,
    (email) => `Watching ${email}. Refresh buttons everywhere just breathed a sigh of relief.`,
    (email) => `10 minutes on ${email}. That's nine more than I usually need.`,
    (email) => `${email} locked in. Ticketmaster has no idea what's coming.`,
  ],
  foundNumber: [
    (num) => `Found ${num}. Waking it up from its nap.`,
    (num) => `${num} located. Let's see if it remembers how to work.`,
    (num) => `Got ${num}. Bringing it online.`,
    (num) => `${num} acquired. Time to wake up.`,
  ],
  activated: [
    (slot) => `Slot ${slot} is awake and caffeinated.`,
    (slot) => `Live on slot ${slot}. Listening.`,
    (slot) => `Online. Slot ${slot} ready.`,
    (slot) => `Slot ${slot} activated. Let's get this bread.`,
  ],
  codeFound: [
    (code) => `*${code}* — Ticketmaster never saw me coming. 🎯`,
    (code) => `Got it: *${code}*. Old way would've taken three email forwards and a prayer.`,
    (code) => `Code: *${code}*. I love my job.`,
    (code) => `*${code}*. Somewhere a manual refresher just felt a chill.`,
    (code) => `*${code}* delivered. You can stop holding your breath.`,
    (code) => `Code: *${code}*. This is why they built me.`,
    (code) => `*${code}*. Fastest hands in the inbox. 🚀`,
    (code) => `Got it: *${code}*. Screenshot this for your resume.`,
    (code) => `*${code}*. Another one for the highlight reel.`,
    (code) => `Code secured: *${code}*. The old days are officially over.`,
  ],
  watchCompleteSuccess: [
    () => `Watch complete. Go be a hero.`,
    () => `That's time. Codes delivered, legends made.`,
    () => `Done. The system works. 🚀`,
    () => `And scene. Watch complete.`,
  ],
  watchCompleteEmpty: [
    () => `10 minutes, nothing. Ticketmaster ghosted us. Issues? Ping <@U0144K906KA>.`,
    () => `Watch complete. Came up dry. Blame Ticketmaster. Problems? <@U0144K906KA>.`,
    () => `Nothing. Either it already came through or TM's being TM. Issues? <@U0144K906KA>.`,
    () => `Time's up. No codes. Report issues to <@U0144K906KA>.`,
  ],
  notFound: [
    (email) => `No luck on ${email}. Even I have limits.`,
    (email) => `Couldn't track down ${email}. Use email reset instead.`,
    (email) => `${email} not in the system. Try email reset.`,
  ],
  searching: [
    () => `Hunting...`,
    () => `One sec...`,
    () => `Checking the files...`,
  ],
  activationFailed: [
    () => `SIM's being difficult. Still watching though.`,
    () => `Couldn't wake up the SIM. Watching anyway.`,
    () => `Activation hiccup. Still on the case.`,
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
 * Find the slot for a phone number from recent conversations
 * @param {string} phone - Phone number to look up
 * @returns {{bankId: string, slot: string}|null}
 */
function findSlotByPhone(phone) {
  const normalized = normalizePhone(phone);
  // Look for conversations where this phone is the recipient (our SIM number)
  const conversation = db.findConversationByRecipient(normalized);

  if (conversation && conversation.sim_bank_id && conversation.sim_port) {
    return {
      bankId: conversation.sim_bank_id,
      slot: conversation.sim_port
    };
  }

  return null;
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
 * Check if message contains Ticketmaster code
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
 * Start a Ticketmaster code watch for an email
 * @param {object} slackApp - Slack Bolt app instance
 * @param {string} email - Email address to search for
 * @param {string} slackChannel - Slack channel ID
 * @param {string} threadTs - Thread timestamp for replies
 */
async function startTicketmasterWatch(slackApp, email, slackChannel, threadTs) {
  try {
    const associate = await monday.searchAssociateByEmail(email);

    if (associate) {
      const phoneDisplay = formatPhoneDisplay(associate.phone);
      await postToThread(slackApp, slackChannel, threadTs,
        getMessage('foundNumber', phoneDisplay));

      const slotInfo = findSlotByPhone(associate.phone);

      if (slotInfo) {
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

      // Create watch for Ejoin webhook
      const normalized = normalizePhone(associate.phone);
      activeWatches.set(normalized, {
        endTime: Date.now() + WATCH_DURATION_MS,
        threadTs,
        slackChannel,
        source: 'ejoin',
        email,
        associateName: associate.name,
        codesDelivered: false
      });

      // Opening line
      await postToThread(slackApp, slackChannel, threadTs,
        getMessage('watchStart', email));

      // Set cleanup timer
      setTimeout(() => {
        const watch = activeWatches.get(normalized);
        if (watch && Date.now() >= watch.endTime) {
          activeWatches.delete(normalized);
          const endMsg = watch.codesDelivered
            ? getMessage('watchCompleteSuccess')
            : getMessage('watchCompleteEmpty');
          postToThread(slackApp, slackChannel, threadTs, endMsg).catch(console.error);
        }
      }, WATCH_DURATION_MS);

      console.log(`[TM WATCH] Started Ejoin watch for ${phoneDisplay}`);
      return;
    }

    // Step 2: Not found in Monday, search Textchest

    const textchestNumber = await textchest.findNumberByEmail(email);

    if (textchestNumber) {
      const phoneDisplay = formatPhoneDisplay(textchestNumber.number);
      await postToThread(slackApp, slackChannel, threadTs,
        getMessage('foundNumber', phoneDisplay));

      // Restart the SIM
      try {
        const activateResult = await textchest.activateSim(textchestNumber.number);
        await postToThread(slackApp, slackChannel, threadTs,
          getMessage('activated', activateResult.slot));
      } catch (err) {
        await postToThread(slackApp, slackChannel, threadTs,
          getMessage('activationFailed'));
      }

      // Create watch for Textchest polling
      const normalized = normalizePhone(textchestNumber.number);
      const watch = {
        endTime: Date.now() + WATCH_DURATION_MS,
        threadTs,
        slackChannel,
        source: 'textchest',
        email,
        postedMessages: new Set(),
        codesDelivered: false
      };
      activeWatches.set(normalized, watch);

      // Opening line
      await postToThread(slackApp, slackChannel, threadTs,
        getMessage('watchStart', email));

      // Start polling
      await startTextchestPolling(slackApp, watch, textchestNumber.number);

      console.log(`[TM WATCH] Started Textchest watch for ${phoneDisplay}`);
      return;
    }

    // Not found anywhere
    await postToThread(slackApp, slackChannel, threadTs,
      getMessage('notFound', email));

  } catch (error) {
    console.error('[TM WATCH] Error:', error.message);
    await postToThread(slackApp, slackChannel, threadTs,
      `❌ Error: ${error.message}`);
  }
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

  if (!isTicketmasterMessage(content)) return false;

  // Post to the watch thread
  try {
    watch.codesDelivered = true;
    // Extract 6-digit code if present
    const codeMatch = content.match(/\d{6}/);
    const code = codeMatch ? codeMatch[0] : content;
    await postToThread(slackApp, watch.slackChannel, watch.threadTs,
      getMessage('codeFound', code));
    console.log(`[TM WATCH] Ticketmaster code detected for ${recipientPhone}`);
    return true;
  } catch (err) {
    console.error('[TM WATCH] Failed to post code notification:', err.message);
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
 * Poll Gmail for Ticketmaster emails to a specific email address
 */
async function pollGmailForTicketmaster(slackApp, watch, email) {
  const gmailClient = getGmailClient();
  if (!gmailClient) {
    console.log('[TM WATCH] Gmail not configured, skipping email monitoring');
    return;
  }

  const pollInterval = setInterval(async () => {
    // Check if watch is still active
    if (Date.now() > watch.endTime) {
      clearInterval(pollInterval);
      return;
    }

    try {
      // Search for Ticketmaster code emails:
      // - TO or FROM this email address (direct emails)
      // - OR containing this email address anywhere (forwarded emails)
      // Subject patterns: "authentication code", "reset password", or forwarded versions "FW:"
      // Only get emails from last 1 hour - older codes are irrelevant
      const response = await gmailClient.users.messages.list({
        userId: 'me',
        q: `("${email}" OR to:${email} OR from:${email}) (subject:"authentication code" OR subject:"reset password") newer_than:1h`,
        maxResults: 10
      });

      const messages = response.data.messages || [];

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

        // Extract body
        let body = '';
        const payload = fullMessage.data.payload;
        if (payload.body?.data) {
          body = Buffer.from(payload.body.data, 'base64').toString('utf8');
        } else if (payload.parts) {
          const textPart = payload.parts.find(p => p.mimeType === 'text/plain');
          if (textPart?.body?.data) {
            body = Buffer.from(textPart.body.data, 'base64').toString('utf8');
          }
        }

        // Extract Ticketmaster authentication/reset code
        // Authentication emails: "Your Authentication Code:\n594137"
        // Password reset emails: "Your Reset Code:\n026502"
        let code = null;
        const patterns = [
          /authentication\s*code[:\s]*(\d{6})/i,
          /reset\s*code[:\s]*(\d{6})/i,
          /your\s*code[:\s]*(\d{6})/i,
          /verification\s*code[:\s]*(\d{6})/i,
          /code\s*is[:\s]*(\d{6})/i,
        ];
        for (const pattern of patterns) {
          const match = body.match(pattern);
          if (match) {
            code = match[1];
            break;
          }
        }
        // Fallback: look for any 6-digit number after "code" keyword
        if (!code) {
          const fallbackMatch = body.match(/code[\s\S]{0,50}?(\d{6})/i);
          code = fallbackMatch ? fallbackMatch[1] : null;
        }

        watch.postedEmails.add(msg.id);

        // Post code if found
        if (code) {
          watch.codesDelivered = true;
          await postToThread(slackApp, watch.slackChannel, watch.threadTs,
            getMessage('codeFound', code));
        }

        // Mark as read
        await gmailClient.users.messages.modify({
          userId: 'me',
          id: msg.id,
          requestBody: { removeLabelIds: ['UNREAD'] }
        });
      }
    } catch (err) {
      console.error('[TM WATCH] Gmail poll error:', err.message);
    }
  }, POLL_INTERVAL_MS);

  // Store interval reference
  watch.gmailPollInterval = pollInterval;
}

/**
 * Start a simplified Textchest-only watch (no Monday.com)
 * Also monitors Gmail for Ticketmaster emails
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
    let codesDelivered = false;

    // Step 1: Try Textchest
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
      // Step 2: Try Monday.com for SS number
      const associate = await monday.searchAssociateByEmail(email);

      if (associate) {
        phoneDisplay = formatPhoneDisplay(associate.phone);

        // Query SIM banks directly to find which slot has this number
        const slotInfo = await simbank.findSlotByPhone(associate.phone);

        if (slotInfo) {
          smsSource = 'ss';
          watchKey = normalizePhone(associate.phone);
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
      }
    }

    // If nothing found, bail
    if (!smsSource) {
      await postToThread(slackApp, slackChannel, threadTs,
        getMessage('notFound', email));
      return;
    }

    // Create watch
    const watch = {
      endTime: Date.now() + WATCH_DURATION_MS,
      threadTs,
      slackChannel,
      source: smsSource || 'gmail-only',
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

    // Always start Gmail polling
    pollGmailForTicketmaster(slackApp, watch, email);

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

    console.log(`[TM WATCH] Started watch for ${email}: SMS=${smsSource || 'none'}, Gmail=yes`);

  } catch (error) {
    console.error('[TM WATCH] Error:', error.message);
    await postToThread(slackApp, slackChannel, threadTs,
      `❌ Error: ${error.message}`);
  }
}

module.exports = {
  startTicketmasterWatch,
  startTextchestWatch,
  checkWatchAndNotify,
  hasActiveWatch,
  getActiveWatch
};
