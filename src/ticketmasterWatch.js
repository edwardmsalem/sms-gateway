/**
 * Ticketmaster Code Watch Module
 * Monitors for Ticketmaster verification codes via Ejoin or Textchest
 */

const db = require('./database');
const monday = require('./monday');
const simbank = require('./simbank');
const textchest = require('./textchest');
const { normalizePhone, formatPhoneDisplay } = require('./utils');

// Active watches: Map<normalizedPhone, { endTime, threadTs, slackChannel, source: 'ejoin'|'textchest' }>
const activeWatches = new Map();

// Watch duration: 10 minutes
const WATCH_DURATION_MS = 10 * 60 * 1000;

// Textchest polling interval: 30 seconds
const TEXTCHEST_POLL_INTERVAL_MS = 30 * 1000;

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
 * Start Textchest polling for a watch
 */
async function startTextchestPolling(slackApp, watch, number) {
  const startTs = Math.floor(Date.now() / 1000);

  const pollInterval = setInterval(async () => {
    // Check if watch is still active
    if (Date.now() > watch.endTime) {
      clearInterval(pollInterval);
      await postToThread(slackApp, watch.slackChannel, watch.threadTs,
        "⏱️ Watch complete. No more monitoring.");
      activeWatches.delete(normalizePhone(number));
      return;
    }

    try {
      // Get messages since watch started
      const messages = await textchest.getMessages(number, 100, startTs);

      // Filter for Ticketmaster messages
      for (const msg of messages) {
        const content = msg.body || msg.message || msg.content || '';
        if (isTicketmasterMessage(content)) {
          // Check if we've already posted this message
          if (!watch.postedMessages) watch.postedMessages = new Set();
          const msgKey = `${msg.id || msg.ts || content.substring(0, 50)}`;

          if (!watch.postedMessages.has(msgKey)) {
            watch.postedMessages.add(msgKey);
            await postToThread(slackApp, watch.slackChannel, watch.threadTs,
              `🎫 Ticketmaster code received:\n"${content}"`);
          }
        }
      }
    } catch (err) {
      console.error('[TM WATCH] Textchest poll error:', err.message);
    }
  }, TEXTCHEST_POLL_INTERVAL_MS);

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
    // Step 1: Search Monday.com for the email
    await postToThread(slackApp, slackChannel, threadTs,
      `🔍 Searching Monday.com for SS number linked to ${email}...`);

    const associate = await monday.searchAssociateByEmail(email);

    if (associate) {
      // Found in Monday.com
      const phoneDisplay = formatPhoneDisplay(associate.phone);
      await postToThread(slackApp, slackChannel, threadTs,
        `✅ Found SS number: ${phoneDisplay} (Associate: ${associate.name}). Activating...`);

      // Find the slot for this phone number
      const slotInfo = findSlotByPhone(associate.phone);

      if (slotInfo) {
        // Activate the slot
        const bank = db.getSimBank(slotInfo.bankId);
        if (bank) {
          try {
            await simbank.activateSlot(bank, slotInfo.slot);
            await postToThread(slackApp, slackChannel, threadTs,
              `📱 SIM activated (Bank ${slotInfo.bankId}, Slot ${slotInfo.slot}). Watching #sms for Ticketmaster codes for 10 minutes...`);
          } catch (err) {
            await postToThread(slackApp, slackChannel, threadTs,
              `⚠️ Could not activate slot: ${err.message}. Still watching for codes...`);
          }
        }
      } else {
        await postToThread(slackApp, slackChannel, threadTs,
          `📱 Slot not found in history. Watching #sms for Ticketmaster codes for 10 minutes...`);
      }

      // Create watch for Ejoin webhook
      const normalized = normalizePhone(associate.phone);
      activeWatches.set(normalized, {
        endTime: Date.now() + WATCH_DURATION_MS,
        threadTs,
        slackChannel,
        source: 'ejoin',
        email,
        associateName: associate.name
      });

      // Set cleanup timer
      setTimeout(() => {
        const watch = activeWatches.get(normalized);
        if (watch && Date.now() >= watch.endTime) {
          activeWatches.delete(normalized);
          postToThread(slackApp, slackChannel, threadTs,
            "⏱️ Watch complete. No more monitoring.").catch(console.error);
        }
      }, WATCH_DURATION_MS);

      console.log(`[TM WATCH] Started Ejoin watch for ${phoneDisplay}`);
      return;
    }

    // Step 2: Not found in Monday, search Textchest
    await postToThread(slackApp, slackChannel, threadTs,
      "Not found in Monday.com. Searching Textchest...");

    const textchestNumber = await textchest.findNumberByEmail(email);

    if (textchestNumber) {
      const phoneDisplay = formatPhoneDisplay(textchestNumber.number);
      await postToThread(slackApp, slackChannel, threadTs,
        `✅ Found Textchest number: ${phoneDisplay}. Activating...`);

      // Restart the SIM
      try {
        await textchest.restartSim(textchestNumber.number);
        await postToThread(slackApp, slackChannel, threadTs,
          `📱 Number activated. Watching for Ticketmaster codes for 10 minutes...`);
      } catch (err) {
        await postToThread(slackApp, slackChannel, threadTs,
          `⚠️ Could not restart SIM: ${err.message}. Still watching for codes...`);
      }

      // Create watch for Textchest polling
      const normalized = normalizePhone(textchestNumber.number);
      const watch = {
        endTime: Date.now() + WATCH_DURATION_MS,
        threadTs,
        slackChannel,
        source: 'textchest',
        email,
        postedMessages: new Set()
      };
      activeWatches.set(normalized, watch);

      // Start polling
      await startTextchestPolling(slackApp, watch, textchestNumber.number);

      console.log(`[TM WATCH] Started Textchest watch for ${phoneDisplay}`);
      return;
    }

    // Not found anywhere
    await postToThread(slackApp, slackChannel, threadTs,
      `❌ No phone number found for ${email}. Use email reset instead.`);

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
    await postToThread(slackApp, watch.slackChannel, watch.threadTs,
      `🎫 Ticketmaster code received:\n"${content}"`);
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

module.exports = {
  startTicketmasterWatch,
  checkWatchAndNotify,
  hasActiveWatch,
  getActiveWatch
};
