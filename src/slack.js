const { App, ExpressReceiver } = require('@slack/bolt');
const crypto = require('crypto');
const db = require('./database');
const simbank = require('./simbank');
const textchest = require('./textchest');
const { formatPhoneDisplay, parsePhoneFromCommand, formatTime } = require('./utils');
const { trackOutboundSms } = require('./deliveryTracker');
const sweepTest = require('./sweepTest');
const slotScan = require('./slotScan');
const ticketmasterWatch = require('./ticketmasterWatch');

const CHANNEL_ID = process.env.SLACK_CHANNEL_ID;
const SPAM_CHANNEL_ID = 'C0A1EUF2D36';
const VERIFICATION_CHANNEL_ID = 'C05KCUMN35M';
const SIM_ACTIVATE_CHANNEL_ID = 'C0A3LSXGCGY';

// SIM Activation watches - track active watches to post SMS to threads
// Key: normalized phone (10 digits), Value: { threadTs, channel, endTime }
const simActivationWatches = new Map();
const SIM_WATCH_DURATION_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Normalize phone to 10 digits (strip leading 1 if present)
 */
function normalizeToTenDigits(phone) {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return digits.substring(1);
  }
  return digits;
}

// Spam threading: key = "sender|contentHash", value = { thread_ts, channel, count, timestamp, parentTs, recipients }
const spamThreads = new Map();
const SPAM_THREAD_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Generate a spam key from sender and content
 */
function getSpamKey(senderPhone, content) {
  // Use first 100 chars of content to create key
  const contentKey = content.substring(0, 100).toLowerCase().trim();
  return `${senderPhone}|${contentKey}`;
}

/**
 * Clean up expired spam threads
 */
function cleanupSpamThreads() {
  const now = Date.now();
  for (const [key, data] of spamThreads) {
    if (now - data.timestamp > SPAM_THREAD_EXPIRY_MS) {
      spamThreads.delete(key);
    }
  }
}

/**
 * Defang URLs to prevent Slack from making them clickable
 * Replaces . with [.] in URLs
 */
function defangUrls(text) {
  // Match URLs (http, https, or www)
  return text.replace(/https?:\/\/[^\s]+|www\.[^\s]+/gi, (url) => {
    return url.replace(/\./g, '[.]');
  });
}

/**
 * Check if message contains a verification code from known services
 * Only email providers and ticket websites bypass spam filter
 */
function isVerificationCode(content) {
  if (!content) return false;
  const text = content.toLowerCase();

  // Google verification codes: G- followed by 6 digits
  if (/g-\d{6}/i.test(content)) return true;

  // Email providers
  if (text.includes('google') && (text.includes('code') || text.includes('verification'))) return true;
  if (text.includes('gmail')) return true;
  if (text.includes('microsoft')) return true;
  if (text.includes('yahoo')) return true;
  if (text.includes('outlook')) return true;

  // Ticketing services
  if (text.includes('ticketmaster')) return true;
  if (text.includes('stubhub')) return true;
  if (text.includes('seatgeek')) return true;
  if (text.includes('vivid seats')) return true;
  if (text.includes('axs')) return true;
  if (text.includes('mlb')) return true;

  return false;
}

// Approved Slack user IDs who can send SMS via @Salem AI command
const APPROVED_SMS_USERS = ['U05BRER83HT', 'U08FY4FAJ9J', 'U0144K906KA'];

// Create an ExpressReceiver so we can mount it on our Express app
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: '/'
});

// Initialize Slack app with the receiver
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver
});

/**
 * Build SMS message blocks for Slack (outbound messages)
 */
function buildSmsBlocks({ recipientDisplay, senderDisplay, content, bankId, port, timestamp, isOutbound, sentBy, iccid }) {
  const icon = isOutbound ? '📤' : '📨';
  const title = isOutbound ? 'Outgoing SMS' : `New SMS to ${recipientDisplay}`;

  let text = `${icon} *${title}*\n━━━━━━━━━━━━━━━━━━━━━━━\n💬 ${content}\n━━━━━━━━━━━━━━━━━━━━━━━\n`;

  if (isOutbound) {
    text += `To: ${senderDisplay}\nFrom: ${recipientDisplay}`;
    if (bankId) text += `\n📍 Bank ${bankId} · Port ${port}`;
    text += `\nSent by: <@${sentBy}> | ${timestamp}`;
  } else {
    text += `From: ${senderDisplay}\n📍 *Bank ${bankId} · Slot ${port}*`;
    if (iccid) text += `\n• *ICCID:* ${iccid}`;
    text += `\nReceived: ${timestamp}\n\n\`@Salem AI reply ${bankId} ${port}\`\n*Copy above, then add your message*`;
  }

  return [{
    type: 'section',
    text: { type: 'mrkdwn', text }
  }];
}

/**
 * Check if sender area code matches any deal's team market
 */
function checkAreaCodeMatch(senderAreaCode, deals) {
  if (!senderAreaCode || !deals || deals.length === 0) return false;

  const monday = require('./monday');
  for (const deal of deals) {
    if (deal.team) {
      const result = monday.doesAreaCodeMatchTeam(senderAreaCode, deal.team);
      if (result.matches) return true;
    }
  }
  return false;
}

/**
 * Find the deal that best matches the sender's region
 * Returns the matching deal, or the first deal if no regional match
 */
function findBestMatchingDeal(senderAreaCode, deals) {
  if (!deals || deals.length === 0) return null;
  if (deals.length === 1) return deals[0];

  const monday = require('./monday');

  // First, try to find a deal that matches the sender's region
  if (senderAreaCode) {
    for (const deal of deals) {
      if (deal.team) {
        const result = monday.doesAreaCodeMatchTeam(senderAreaCode, deal.team);
        if (result.matches) return deal;
      }
    }
  }

  // No regional match, return first deal
  return deals[0];
}

/**
 * Build enriched SMS message blocks with Monday.com deal info
 */
function buildEnrichedSmsBlocks({ content, bankId, port, enrichment, iccid }) {
  const monday = require('./monday');
  const { deals, senderAreaCode, senderStateName, senderPhoneFormatted, receiverPhoneFormatted } = enrichment;

  let text = '';

  if (deals && deals.length > 0) {
    const senderState = monday.getStateFromAreaCode(senderAreaCode);

    // Filter deals to those matching sender's state
    let stateMatchedDeals = [];
    if (senderState) {
      stateMatchedDeals = deals.filter(deal => {
        if (!deal.team) return false;
        const result = monday.doesAreaCodeMatchTeam(senderAreaCode, deal.team);
        return result.matches;
      });
    }

    // Use state-matched deals if any, otherwise show all deals
    const dealsToShow = stateMatchedDeals.length > 0 ? stateMatchedDeals : deals;
    const showingAllDeals = stateMatchedDeals.length === 0 && deals.length > 0;

    // Get associate info from first deal
    const firstDeal = deals[0];

    // Header: Associate name and receiver phone
    text += `📥 *New SMS to ${firstDeal.associateName}* · ${receiverPhoneFormatted}\n`;

    // From line with state info
    const stateDisplay = senderState || 'Unknown';
    text += `From: ${senderPhoneFormatted} · ${stateDisplay}\n`;

    // Get closer Slack mention from first deal
    let closerMention = '';
    if (firstDeal.closer) {
      const closerSlackId = monday.getCloserSlackId(firstDeal.closer);
      closerMention = closerSlackId ? ` <@${closerSlackId}>` : ` @${firstDeal.closer}`;
    }

    // Deal line(s) - show all matching deals
    if (dealsToShow.length === 1) {
      const regionNote = showingAllDeals ? ' _(no deals in state)_' : '';
      text += `Deal: ${dealsToShow[0].team} (${dealsToShow[0].status})${closerMention}${regionNote}\n`;
    } else {
      const regionNote = showingAllDeals ? ' _(no deals in state, showing all)_' : '';
      const dealsList = dealsToShow.map(d => `${d.team} (${d.status})`).join(', ');
      text += `Deals: ${dealsList}${closerMention}${regionNote}\n`;
    }

    text += '\n';
    text += `"${content}"\n\n`;
    text += `_Reply: @Salem AI reply ${bankId} ${port} followed by your message_`;
  } else {
    // Format without deal info
    text += `📥 *New SMS to ${receiverPhoneFormatted}*\n`;
    text += `From: ${senderPhoneFormatted} · ${senderStateName || 'Unknown'}\n\n`;
    text += `"${content}"\n\n`;
    text += `_Reply: @Salem AI reply ${bankId} ${port} followed by your message_`;
  }

  return [{
    type: 'section',
    text: { type: 'mrkdwn', text }
  }];
}

/**
 * Post a new conversation to Slack channel
 */
async function postNewConversation(conversation, messageContent, enrichment) {
  const bankId = conversation.sim_bank_id;
  const port = conversation.sim_port;

  // Route verification codes to dedicated channel
  const targetChannel = isVerificationCode(messageContent) ? VERIFICATION_CHANNEL_ID : CHANNEL_ID;

  // Use enriched blocks if enrichment data is provided
  const blocks = enrichment
    ? buildEnrichedSmsBlocks({
        content: messageContent,
        bankId,
        port,
        enrichment,
        iccid: conversation.iccid
      })
    : buildSmsBlocks({
        recipientDisplay: formatPhoneDisplay(conversation.recipient_phone),
        senderDisplay: formatPhoneDisplay(conversation.sender_phone),
        content: messageContent,
        bankId,
        port,
        timestamp: formatTime(),
        isOutbound: false,
        iccid: conversation.iccid
      });

  const result = await app.client.chat.postMessage({
    channel: targetChannel,
    text: `New SMS to ${formatPhoneDisplay(conversation.recipient_phone)}`,
    blocks
  });

  return result.ts;
}

/**
 * Post an inbound message to existing thread
 * Returns { postedTs, actualThreadTs }
 */
async function postInboundToThread(threadTs, senderPhone, recipientPhone, content, conversation, enrichment) {
  const bankId = conversation?.sim_bank_id || 'unknown';
  const port = conversation?.sim_port || 'PORT';

  // Use enriched blocks if enrichment data is provided
  const blocks = enrichment
    ? buildEnrichedSmsBlocks({
        content,
        bankId,
        port,
        enrichment,
        iccid: conversation?.iccid
      })
    : buildSmsBlocks({
        recipientDisplay: formatPhoneDisplay(recipientPhone),
        senderDisplay: formatPhoneDisplay(senderPhone),
        content,
        bankId,
        port,
        timestamp: formatTime(),
        isOutbound: false,
        iccid: conversation?.iccid
      });

  // Always post to the existing conversation thread in regular channel
  const result = await app.client.chat.postMessage({
    channel: CHANNEL_ID,
    thread_ts: threadTs,
    reply_broadcast: true,
    text: `New message from ${formatPhoneDisplay(senderPhone)}`,
    blocks
  });

  // If it's a verification code, ALSO post to the verification channel
  if (isVerificationCode(content)) {
    try {
      await app.client.chat.postMessage({
        channel: VERIFICATION_CHANNEL_ID,
        text: `New message from ${formatPhoneDisplay(senderPhone)}`,
        blocks
      });
    } catch (err) {
      console.error('[SLACK] Failed to post to verification channel:', err.message);
    }
  }

  // If thread didn't exist, result.ts becomes the new thread
  const actualThreadTs = result.message?.thread_ts || result.ts;
  return { postedTs: result.ts, actualThreadTs };
}

/**
 * Post an outbound message confirmation to thread
 */
async function postOutboundToThread(threadTs, content, slackUser, conversation) {
  await app.client.chat.postMessage({
    channel: CHANNEL_ID,
    thread_ts: threadTs,
    text: `Sent: ${content}`,
    blocks: buildSmsBlocks({
      recipientDisplay: formatPhoneDisplay(conversation?.recipient_phone || 'Unknown'),
      senderDisplay: formatPhoneDisplay(conversation?.sender_phone || 'Unknown'),
      content,
      bankId: conversation?.sim_bank_id,
      port: conversation?.sim_port,
      timestamp: formatTime(),
      isOutbound: true,
      sentBy: slackUser
    })
  });
}

/**
 * Add emoji reaction to a message
 */
async function addReaction(channel, timestamp, emoji) {
  try {
    await app.client.reactions.add({ channel, timestamp, name: emoji });
  } catch (error) {
    if (error.data?.error !== 'already_reacted') {
      console.error(`Failed to add ${emoji} reaction:`, error.message);
    }
  }
}

/**
 * Post a spam message to the spam channel with threading
 * Groups identical spam (same sender + content) into threads
 */
async function postSpamMessage(senderPhone, recipientPhone, content, spamResult, bankId, slot) {
  const monday = require('./monday');
  const senderDisplay = formatPhoneDisplay(senderPhone);
  const recipientDisplay = formatPhoneDisplay(recipientPhone);

  // Get sender state from area code
  const senderAreaCode = monday.getAreaCodeFromPhone(senderPhone);
  const senderState = monday.getStateFromAreaCode(senderAreaCode);

  // Clean up expired threads
  cleanupSpamThreads();

  // Check if we have an existing thread for this spam
  const spamKey = getSpamKey(senderPhone, content);
  const existingThread = spamThreads.get(spamKey);

  if (existingThread) {
    // Check if we've already posted for this recipient
    if (existingThread.recipients.has(recipientPhone)) {
      console.log(`[SPAM THREAD] Duplicate recipient skipped: ${recipientDisplay}`);
      return;
    }

    // Add recipient to set and update thread
    existingThread.recipients.add(recipientPhone);
    existingThread.count++;
    existingThread.timestamp = Date.now();

    // Post reply in thread
    await app.client.chat.postMessage({
      channel: SPAM_CHANNEL_ID,
      thread_ts: existingThread.thread_ts,
      text: `Also sent to: ${recipientDisplay}`,
      unfurl_links: false,
      unfurl_media: false
    });

    // Update parent message with new count
    const messageText = content.length > 500 ? content.substring(0, 500) + '...' : content;
    let parentText = `🚫 *SPAM*  ·  ${senderDisplay}  ·  ${senderState || 'Unknown'}`;
    if (bankId === 'maxsip') {
      parentText += `  ·  Maxsip`;
    }
    parentText += `  ·  ${spamResult.category || 'Spam'}  ·  _${existingThread.count} recipients_\n`;
    parentText += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    parentText += `${messageText}\n`;
    parentText += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

    try {
      await app.client.chat.update({
        channel: SPAM_CHANNEL_ID,
        ts: existingThread.parentTs,
        text: parentText
      });
    } catch (err) {
      console.error('Failed to update spam parent message:', err.message);
    }

    console.log(`[SPAM THREAD] Added to thread ${existingThread.thread_ts}, count: ${existingThread.count}`);
  } else {
    // Create new parent message with clear separators
    const messageText = content.length > 500 ? content.substring(0, 500) + '...' : content;

    let text = `🚫 *SPAM*  ·  ${senderDisplay} → ${recipientDisplay}  ·  ${senderState || 'Unknown'}`;
    if (bankId === 'maxsip') {
      text += `  ·  Maxsip`;
    } else if (bankId) {
      text += `  ·  Bank ${bankId}`;
    }
    text += `  ·  ${spamResult.category || 'Spam'}\n`;
    text += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    text += `${messageText}\n`;
    text += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

    const result = await app.client.chat.postMessage({
      channel: SPAM_CHANNEL_ID,
      text,
      unfurl_links: false,
      unfurl_media: false
    });

    // Store thread info with recipients set
    spamThreads.set(spamKey, {
      thread_ts: result.ts,
      parentTs: result.ts,
      channel: SPAM_CHANNEL_ID,
      count: 1,
      timestamp: Date.now(),
      recipients: new Set([recipientPhone])
    });

    console.log(`[SPAM THREAD] Created new thread ${result.ts} for ${senderDisplay}`);
  }
}

/**
 * Update or post a progress message in a thread
 */
async function updateProgressMessage(channel, threadTs, progressTs, text) {
  if (!progressTs) {
    const result = await app.client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text
    });
    return result.ts;
  }

  await app.client.chat.update({ channel, ts: progressTs, text });
  return progressTs;
}

/**
 * Try to find conversation by looking up parent message phone number
 */
async function findConversationFromParent(channel, threadTs) {
  try {
    const parentResult = await app.client.conversations.replies({
      channel,
      ts: threadTs,
      limit: 1
    });

    if (parentResult.messages?.[0]) {
      const parentText = parentResult.messages[0].text || '';
      const fromMatch = parentText.match(/From:\s*\((\d{3})\)\s*(\d{3})-(\d{4})/);
      if (fromMatch) {
        const senderPhone = `+1${fromMatch[1]}${fromMatch[2]}${fromMatch[3]}`;
        const conversation = db.findConversationBySender(senderPhone);
        if (conversation) {
          db.updateConversationThread(threadTs, conversation.id);
          return conversation;
        }
      }
    }
  } catch (err) {
    console.error('Parent message lookup failed:', err.message);
  }
  return null;
}

/**
 * Format slot status for Slack display
 */
function formatSlotStatusForSlack(status) {
  if (status.error) {
    return `:x: *Error:* ${status.error}`;
  }

  const activeIcon = status.active === 1 || status.active === '1' ? ':white_check_mark: Yes' : ':x: No';
  const activeValue = status.active;

  // Status icon: green for ready (3), yellow for registering (2), red for others
  let statusIcon = ':x:';
  if (status.st === 3) {
    statusIcon = ':white_check_mark:';
  } else if (status.st === 2) {
    statusIcon = ':hourglass_flowing_sand:';
  }

  let text = `:bar_chart: *Status for ${status.bankId} slot ${status.slot}*\n`;
  text += `• *Active:* ${activeIcon} (${activeValue})\n`;
  text += `• *Status:* ${statusIcon} ${status.statusText} (${status.st})\n`;
  text += `• *Phone:* ${status.sn}\n`;
  text += `• *Signal:* ${status.sig !== undefined ? `${status.sig} dBm` : 'N/A'}\n`;
  text += `• *Balance:* ${status.bal}\n`;
  text += `• *Operator:* ${status.opr}`;

  return text;
}

/**
 * @Salem AI mention handler
 * Commands:
 * - @Salem AI tm <email> - Watch for Ticketmaster codes (SMS + Email)
 * - @Salem AI scan - Run slot scan (cycles through slots 01-08)
 * - @Salem AI reply <bank> <slot> <message> - Send SMS reply (in thread)
 * - @Salem AI status <bank> <slot> - Check SIM slot status
 */
app.event('app_mention', async ({ event, say }) => {
  await addReaction(event.channel, event.ts, 'eyes');

  // Parse the command text - strip ALL mentions and formatting (italic _, bold *, strikethrough ~)
  let fullText = event.text.replace(/<@[^>]+>/gi, '').trim();
  fullText = fullText.replace(/^[_*~]+|[_*~]+$/g, '').trim();
  const parts = fullText.split(/\s+/);

  console.log(`[MENTION DEBUG] Raw text: "${event.text}"`);
  console.log(`[MENTION DEBUG] Parsed: "${fullText}"`);
  console.log(`[MENTION DEBUG] Parts: ${JSON.stringify(parts)}`);
  console.log(`[MENTION DEBUG] User: ${event.user}, Thread: ${event.thread_ts || 'none'}`);

  // Check if this is a status command
  if (parts[0]?.toLowerCase() === 'status') {
    const bankId = parts[1];
    const slot = parts[2];

    if (!bankId || !slot) {
      await say({
        text: `📊 *Check SIM Status*\n\nFormat: \`@Salem AI status <bank> <slot>\`\n\n*Example:*\n\`@Salem AI status 50001 3.05\``,
        thread_ts: event.thread_ts || event.ts
      });
      return;
    }

    try {
      const status = await simbank.getSlotStatus(bankId, slot);
      await say({
        text: formatSlotStatusForSlack(status),
        thread_ts: event.thread_ts || event.ts
      });
      await addReaction(event.channel, event.ts, 'white_check_mark');
    } catch (error) {
      await say({
        text: `:x: *Error:* ${error.message}`,
        thread_ts: event.thread_ts || event.ts
      });
      await addReaction(event.channel, event.ts, 'x');
    }
    return;
  }

  // Check if this is a Ticketmaster code watch: @Salem AI tm <email>
  if (parts[0]?.toLowerCase() === 'tm') {
    // Extract email - Slack auto-links as <mailto:user@example.com|user@example.com>
    const restOfText = fullText.replace(/^tm\s+/i, '');
    const emailMatch = restOfText.match(/<mailto:([^|]+)\|[^>]+>/) || restOfText.match(/^([^\s@]+@[^\s@]+\.[^\s@]+)$/i);

    if (!emailMatch) {
      await say({
        text: 'Usage: `@Salem AI tm <email>`\nExample: `@Salem AI tm user@example.com`',
        thread_ts: event.thread_ts || event.ts
      });
      return;
    }

    const email = emailMatch[1];
    await say({
      text: `🎫 Starting Ticketmaster code watch for ${email}...\n_Searching Textchest + Gmail for 10 minutes_`,
      thread_ts: event.ts
    });

    // Start the Textchest+Gmail watch asynchronously
    setImmediate(() => {
      ticketmasterWatch.startTextchestWatch(app, email, event.channel, event.ts)
        .catch(error => {
          console.error('[TMCODE] Textchest watch failed:', error.message);
          app.client.chat.postMessage({
            channel: event.channel,
            thread_ts: event.ts,
            text: `:x: Error: ${error.message}`
          }).catch(e => console.error('[TMCODE] Failed to post error:', e.message));
        });
    });
    return;
  }

  // Check if this is a slot scan command: @Salem AI scan or @Salem AI slot scan
  if (parts[0]?.toLowerCase() === 'scan' || (parts[0]?.toLowerCase() === 'slot' && parts[1]?.toLowerCase() === 'scan')) {
    // Check if a scan is already running
    if (slotScan.getActiveScan()) {
      await say({
        text: '⚠️ A slot scan is already in progress. Please wait for it to complete (~24 min).',
        thread_ts: event.thread_ts || event.ts
      });
      return;
    }

    // Check if sweep test is running
    if (sweepTest.getActiveTest()) {
      await say({
        text: '⚠️ A sweep test is in progress. Please wait for it to complete.',
        thread_ts: event.thread_ts || event.ts
      });
      return;
    }

    await say({
      text: '🔄 Starting slot scan... This will take ~24 minutes (8 slots × 3 min each)',
      thread_ts: event.thread_ts || event.ts
    });

    // Run the scan asynchronously
    setImmediate(() => {
      slotScan.runSlotScan(app).catch(error => {
        console.error('[SLOT SCAN] Failed:', error.message);
        app.client.chat.postMessage({
          channel: event.channel,
          thread_ts: event.ts,
          text: `:x: Slot scan failed: ${error.message}`
        }).catch(e => console.error('[SLOT SCAN] Failed to post error:', e.message));
      });
    });

    await addReaction(event.channel, event.ts, 'white_check_mark');
    return;
  }

  // Check if this is an SMS reply: @Salem AI reply <bank> <slot> <message>
  if (parts[0]?.toLowerCase() === 'reply') {
    // Check if user is authorized to send SMS
    if (!APPROVED_SMS_USERS.includes(event.user)) {
      await say({
        text: ':no_entry: You are not authorized to send SMS via this bot.',
        thread_ts: event.thread_ts || event.ts
      });
      return;
    }

    // Must be in a thread for SMS sending
    if (!event.thread_ts) {
      await say({
        text: `📱 *How to Send SMS Reply*\n\nGo to any conversation thread and type:\n\`@Salem AI reply <bank> <slot> <message>\`\n\n*Example:*\n\`@Salem AI reply 50001 3.05 Thanks for reaching out!\`\n\nThe bank ID and slot are shown in each message.`,
        thread_ts: event.ts
      });
      return;
    }

    // Parse: @Salem AI reply [bank] [slot] [message]
    const specifiedBank = parts[1];
    const specifiedSlot = parts[2];
    const message = parts.slice(3).join(' ');

    // Validate bank format (e.g., "50004")
    if (!specifiedBank || !/^\d{5}$/.test(specifiedBank)) {
      await say({
        text: `❌ *Missing Bank ID*\n\nFormat: \`@Salem AI reply <bank> <slot> <message>\`\n\nCheck the original message for the Bank ID (5 digits like 50001, 50024, etc.)`,
        thread_ts: event.thread_ts
      });
      return;
    }

    // Validate slot format (e.g., "4.07", "1.01")
    if (!specifiedSlot || !/^\d+\.\d+$/.test(specifiedSlot)) {
      await say({
        text: `❌ *Missing Slot*\n\nFormat: \`@Salem AI reply ${specifiedBank} <slot> <message>\`\n\nCheck the original message for the Slot (format like 4.07, 1.01, etc.)`,
        thread_ts: event.thread_ts
      });
      return;
    }

    if (!message) {
      await say({
        text: `❌ *Missing Message*\n\nFormat: \`@Salem AI reply ${specifiedBank} ${specifiedSlot} <your message here>\``,
        thread_ts: event.thread_ts
      });
      return;
    }

    // Look up conversation by thread_ts
    let conversation = db.findConversationByThreadTs(event.thread_ts);

    // Fallback: try to find by extracting phone from parent message
    if (!conversation) {
      conversation = await findConversationFromParent(event.channel, event.thread_ts);
    }

    if (!conversation) {
      await say({
        text: 'Could not find conversation for this thread. Please check the thread.',
        thread_ts: event.thread_ts
      });
      return;
    }

    // Check if specified bank matches conversation's bank
    const conversationBank = conversation.sim_bank_id;
    if (specifiedBank !== conversationBank) {
      await say({
        text: `:warning: *Warning:* Sending from bank ${specifiedBank}, but conversation originated from bank ${conversationBank}`,
        thread_ts: event.thread_ts
      });
    }

    const bankId = specifiedBank;
    const toPhone = conversation.sender_phone;

    try {
      let progressTs = null;

      // Progress callback for slot activation status
      const onProgress = async (step, msg) => {
        const stepEmoji = {
          checking: ':mag:',
          ready: ':white_check_mark:',
          switching: ':arrows_counterclockwise:',
          waiting: ':hourglass_flowing_sand:',
          sending: ':outbox_tray:'
        };
        const text = `${stepEmoji[step] || ':gear:'} ${msg}`;

        try {
          progressTs = await updateProgressMessage(event.channel, event.thread_ts, progressTs, text);
        } catch (err) {
          // Progress update failed, continue anyway
        }
      };

      // Send SMS
      await simbank.sendSms(bankId, specifiedSlot, toPhone, message, onProgress);

      // Update progress message to completion
      if (progressTs) {
        try {
          await app.client.chat.update({
            channel: event.channel,
            ts: progressTs,
            text: `:outbox_tray: SMS sent from bank ${bankId} slot ${specifiedSlot}`
          });
        } catch (err) {
          // Ignore update failures
        }
      }

      // Record the message
      db.insertMessage({
        conversation_id: conversation.id,
        direction: 'outbound',
        content: message,
        sent_by_slack_user: event.user,
        status: 'sent'
      });

      db.updateConversationTimestamp(conversation.id);
      await addReaction(event.channel, event.ts, 'outbox_tray');
      trackOutboundSms(toPhone, event.channel, event.ts);

      // Post confirmation with specified slot
      const displayConversation = { ...conversation, sim_bank_id: bankId, sim_port: specifiedSlot };
      await postOutboundToThread(event.thread_ts, message, event.user, displayConversation);

    } catch (error) {
      console.error('Failed to send SMS:', error.message);
      await addReaction(event.channel, event.ts, 'x');
      await say({
        text: `Failed to send: ${error.message}`,
        thread_ts: event.thread_ts
      });
    }
    return;
  }

  // Default: show help message for unrecognized commands
  await say({
    text: `*@Salem AI Commands:*\n• \`@Salem AI tm <email>\` - Watch for Ticketmaster codes\n• \`@Salem AI scan\` - Run slot scan (cycles slots 01-08)\n• \`@Salem AI reply <bank> <slot> <message>\` - Send SMS reply (in thread)\n• \`@Salem AI status <bank> <slot>\` - Check SIM slot status`,
    thread_ts: event.thread_ts || event.ts
  });
});

/**
 * /reply command handler
 * Usage in thread: /reply Your message here
 * Usage outside thread: /reply +15551234567 Your message here
 */
app.command('/reply', async ({ command, ack, respond }) => {
  await ack();

  let conversation = null;
  let phone = null;
  let message = null;

  const channelId = command.channel_id;
  const parsed = parsePhoneFromCommand(command.text);

  if (parsed?.phone) {
    phone = parsed.phone;
    message = parsed.remaining;
    conversation = db.findConversationBySender(phone);
  } else {
    message = command.text.trim();

    if (!message) {
      await respond({
        response_type: 'ephemeral',
        text: 'Usage:\n• In thread: `/reply Your message`\n• Outside thread: `/reply +15551234567 Your message`'
      });
      return;
    }

    // Try to find conversation from channel
    const conversations = db.getRecentConversations(channelId);
    if (conversations?.length === 1) {
      conversation = conversations[0];
      phone = conversation.sender_phone;
    } else if (conversations?.length > 1) {
      await respond({
        response_type: 'ephemeral',
        text: 'Multiple conversations in this channel. Please specify the phone number:\n`/reply +15551234567 Your message`'
      });
      return;
    }

    if (!conversation) {
      await respond({
        response_type: 'ephemeral',
        text: 'Could not find conversation. Please specify the phone number:\n`/reply +15551234567 Your message`'
      });
      return;
    }
  }

  if (!conversation) {
    await respond({
      response_type: 'ephemeral',
      text: `No conversation found with ${formatPhoneDisplay(phone)}`
    });
    return;
  }

  if (!message) {
    await respond({
      response_type: 'ephemeral',
      text: 'Please provide a message to send'
    });
    return;
  }

  try {
    await simbank.sendSms(conversation.sim_bank_id, conversation.sim_port, phone, message);

    db.insertMessage({
      conversation_id: conversation.id,
      direction: 'outbound',
      content: message,
      sent_by_slack_user: command.user_id,
      status: 'sent'
    });

    db.updateConversationTimestamp(conversation.id);

    if (conversation.slack_thread_ts) {
      await postOutboundToThread(conversation.slack_thread_ts, message, command.user_id, conversation);
    }

    await respond({
      response_type: 'ephemeral',
      text: `Message sent to ${formatPhoneDisplay(phone)} via Bank ${conversation.sim_bank_id}, Slot ${conversation.sim_port}`
    });
  } catch (error) {
    console.error('Failed to send SMS:', error.message);
    await respond({
      response_type: 'ephemeral',
      text: `Failed to send message: ${error.message}`
    });
  }
});

/**
 * /block command handler
 * Usage: /block +15551234567 [optional reason]
 */
app.command('/block', async ({ command, ack, respond }) => {
  await ack();

  const parsed = parsePhoneFromCommand(command.text);
  if (!parsed) {
    await respond({
      response_type: 'ephemeral',
      text: 'Usage: `/block +15551234567 [optional reason]`'
    });
    return;
  }

  const phone = parsed.phone;
  const reason = parsed.remaining || null;

  if (db.isNumberBlocked(phone)) {
    await respond({
      response_type: 'ephemeral',
      text: `${formatPhoneDisplay(phone)} is already blocked`
    });
    return;
  }

  db.blockNumber(phone, command.user_id, reason);

  await respond({
    response_type: 'in_channel',
    text: `Blocked ${formatPhoneDisplay(phone)}${reason ? ` - Reason: ${reason}` : ''}\nBlocked by <@${command.user_id}>`
  });
});

/**
 * /unblock command handler
 * Usage: /unblock +15551234567
 */
app.command('/unblock', async ({ command, ack, respond }) => {
  await ack();

  const parsed = parsePhoneFromCommand(command.text);
  if (!parsed) {
    await respond({
      response_type: 'ephemeral',
      text: 'Usage: `/unblock +15551234567`'
    });
    return;
  }

  const phone = parsed.phone;

  if (!db.isNumberBlocked(phone)) {
    await respond({
      response_type: 'ephemeral',
      text: `${formatPhoneDisplay(phone)} is not blocked`
    });
    return;
  }

  db.unblockNumber(phone);

  await respond({
    response_type: 'in_channel',
    text: `Unblocked ${formatPhoneDisplay(phone)}\nUnblocked by <@${command.user_id}>`
  });
});

/**
 * /status command handler
 * Usage: /status [optional: bank_id]
 */
app.command('/status', async ({ command, ack, respond }) => {
  await ack();

  const bankId = command.text.trim();

  try {
    if (bankId) {
      const status = await simbank.getStatus(bankId);
      await respond({
        response_type: 'ephemeral',
        text: simbank.formatStatusForSlack(status)
      });
    } else {
      const statuses = await simbank.getAllBanksStatus();
      const stats = db.getStats();
      const simCounts = await simbank.countActiveSims();

      let message = '*SMS Gateway Status*\n\n';
      message += `*Messages (24h):* ${stats.messagesLast24h}\n`;
      message += `*Total Conversations:* ${stats.totalConversations}\n`;
      message += `*Blocked Numbers:* ${stats.blockedNumbers}\n`;
      message += `*Active SIMs:* ${simCounts.ready}/${simCounts.total}\n\n`;

      for (const status of statuses) {
        message += simbank.formatStatusForSlack(status) + '\n\n';
      }

      await respond({
        response_type: 'ephemeral',
        text: message
      });
    }
  } catch (error) {
    console.error('Failed to get status:', error.message);
    await respond({
      response_type: 'ephemeral',
      text: `Failed to get status: ${error.message}`
    });
  }
});

/**
 * /sweep-test command handler
 * Switches all 64 ports to slot 03 and tracks message arrivals
 * Usage: /sweep-test <bank_id>
 */
app.command('/sweep-test', async ({ command, ack, respond }) => {
  // Acknowledge immediately to avoid Slack timeout
  await ack();

  // Check if a test is already running
  if (sweepTest.getActiveTest()) {
    respond({
      response_type: 'ephemeral',
      text: 'A sweep test is already in progress. Please wait for it to complete.'
    });
    return;
  }

  // Parse bank ID from command text
  const bankId = command.text?.trim();
  if (!bankId) {
    const banks = db.getAllSimBanks();
    const bankList = banks.map(b => b.bank_id).join(', ');
    respond({
      response_type: 'ephemeral',
      text: `Usage: \`/sweep-test <bank_id>\`\nAvailable banks: ${bankList || 'none configured'}`
    });
    return;
  }

  // Verify bank exists
  const bank = db.getSimBank(bankId);
  if (!bank) {
    const banks = db.getAllSimBanks();
    const bankList = banks.map(b => b.bank_id).join(', ');
    respond({
      response_type: 'ephemeral',
      text: `Bank ${bankId} not found.\nAvailable banks: ${bankList || 'none configured'}`
    });
    return;
  }

  // Respond immediately - don't await
  respond({
    response_type: 'ephemeral',
    text: `🧪 Sweep test starting for bank ${bankId}...`
  });

  // Run the test fully asynchronously in the background
  setImmediate(() => {
    sweepTest.runSweepTest(app, bankId).catch(error => {
      console.error('Sweep test failed:', error.message);
      app.client.chat.postMessage({
        channel: sweepTest.TEST_CHANNEL_ID,
        text: `:x: Sweep test failed: ${error.message}`
      }).catch(e => console.error('Failed to post error message:', e.message));
    });
  });
});

/**
 * /cleanup-duplicates command handler
 * Scans channel AND threads for duplicate messages and deletes all but the first occurrence
 * Usage: /cleanup-duplicates [hours] (default: 24 hours)
 */
app.command('/cleanup-duplicates', async ({ command, ack, respond }) => {
  await ack();

  const hours = parseInt(command.text) || 24;
  const channelId = command.channel_id;

  respond({
    response_type: 'ephemeral',
    text: `🧹 Scanning last ${hours} hours for duplicates (including threads)...`
  });

  setImmediate(async () => {
    let progressTs = null;

    // Helper to post/update progress
    async function updateProgress(text) {
      try {
        if (progressTs) {
          await app.client.chat.update({
            channel: channelId,
            ts: progressTs,
            text
          });
        } else {
          const result = await app.client.chat.postMessage({
            channel: channelId,
            text
          });
          progressTs = result.ts;
        }
      } catch (err) {
        console.warn('[CLEANUP] Progress update failed:', err.message);
      }
    }

    try {
      await updateProgress('🔍 Fetching channel history...');

      // Get conversation history
      const oldestTs = (Date.now() / 1000 - hours * 3600).toString();
      let allMessages = [];
      let cursor;
      let pageCount = 0;

      // Paginate through all top-level messages
      do {
        const result = await app.client.conversations.history({
          channel: channelId,
          oldest: oldestTs,
          limit: 200,
          cursor
        });

        allMessages = allMessages.concat(result.messages || []);
        cursor = result.response_metadata?.next_cursor;
        pageCount++;

        if (pageCount % 5 === 0) {
          await updateProgress(`🔍 Fetched ${allMessages.length} messages so far...`);
        }
      } while (cursor);

      await updateProgress(`🔍 Found ${allMessages.length} messages. Scanning threads...`);

      // Also fetch thread replies for messages that have them
      const threadsToFetch = allMessages.filter(m => m.reply_count > 0);

      for (let i = 0; i < threadsToFetch.length; i++) {
        const parentMsg = threadsToFetch[i];
        try {
          const replies = await app.client.conversations.replies({
            channel: channelId,
            ts: parentMsg.ts,
            oldest: oldestTs,
            limit: 200
          });

          // Add replies (skip the parent message which is included in replies)
          const threadReplies = (replies.messages || []).filter(m => m.ts !== parentMsg.ts);
          allMessages = allMessages.concat(threadReplies);
        } catch (err) {
          console.warn(`[CLEANUP] Failed to fetch thread ${parentMsg.ts}: ${err.message}`);
        }

        // Rate limit thread fetches
        await new Promise(r => setTimeout(r, 200));

        // Progress update every 20 threads
        if ((i + 1) % 20 === 0) {
          await updateProgress(`🔍 Scanned ${i + 1}/${threadsToFetch.length} threads (${allMessages.length} messages)...`);
        }
      }

      await updateProgress(`🔍 Analyzing ${allMessages.length} messages for duplicates...`);

      // Filter to bot messages (more lenient - any bot message)
      const botMessages = allMessages.filter(m => m.bot_id && m.text);

      // Extract the core content for comparison
      // Handles two message formats:
      // 1. Enriched: "content" with quotes
      // 2. Non-enriched: 💬 content without quotes
      function extractSmsKey(text) {
        let content = '';

        // Try quoted format first (enriched messages): "content"
        const quotedMatch = text.match(/"([^"]+)"/);
        if (quotedMatch) {
          content = quotedMatch[1].trim();
        } else {
          // Try non-enriched format: 💬 content followed by ━ or newline
          const emojiMatch = text.match(/💬\s*([^━\n]+)/);
          if (emojiMatch) {
            content = emojiMatch[1].trim();
          }
        }

        // Extract phone numbers from the text
        const phoneMatches = text.match(/\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g) || [];
        const phones = phoneMatches.map(p => p.replace(/\D/g, '')).slice(0, 2).sort().join('|');

        if (content && content.length > 3) {
          return `${phones}|${content}`;
        }

        // Fallback: normalize the text by removing variable parts
        return text
          .replace(/\d+\.\d+/g, 'SLOT')
          .replace(/5001[24]/g, 'BANK')
          .replace(/@Salem\s*AI\s+reply\s+\S+\s+\S+/gi, 'REPLY')
          .replace(/·/g, '|')
          .trim();
      }

      // Group by SMS content
      const seen = new Map();
      const duplicates = [];

      for (const msg of botMessages.sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts))) {
        const smsKey = extractSmsKey(msg.text);
        if (!smsKey || smsKey.length < 10) continue;

        const hash = crypto.createHash('md5').update(smsKey).digest('hex');

        if (seen.has(hash)) {
          duplicates.push(msg);
        } else {
          seen.set(hash, msg);
        }
      }

      if (duplicates.length === 0) {
        await updateProgress(`✅ No duplicates found in the last ${hours} hours.\n• Scanned: ${allMessages.length} messages (${threadsToFetch.length} threads)\n• Bot messages checked: ${botMessages.length}`);
        return;
      }

      await updateProgress(`🗑️ Found ${duplicates.length} duplicates. Deleting...`);

      // Delete duplicates with careful rate limiting
      // Slack allows ~50 requests/min for chat.delete (Tier 3)
      let deleted = 0;
      let failed = 0;

      for (const msg of duplicates) {
        try {
          await app.client.chat.delete({
            channel: channelId,
            ts: msg.ts
          });
          deleted++;

          // Small delay after each deletion to stay under rate limit
          await new Promise(r => setTimeout(r, 1200)); // ~50/min
        } catch (err) {
          console.error(`[CLEANUP] Failed to delete ${msg.ts}: ${err.message}`);
          failed++;
        }

        // Progress update every 10 deletions
        if ((deleted + failed) % 10 === 0) {
          await updateProgress(`🗑️ Deleting... ${deleted}/${duplicates.length} (${failed} failed)`);
        }
      }

      await updateProgress(`🧹 Cleanup complete!\n• Scanned: ${allMessages.length} messages (${threadsToFetch.length} threads)\n• Found: ${duplicates.length} duplicates\n• Deleted: ${deleted}\n• Failed: ${failed}`);

    } catch (error) {
      console.error('[CLEANUP] Error:', error.message);
      await updateProgress(`:x: Cleanup failed: ${error.message}`);
    }
  });
});

/**
 * Message listener for "tm" command (without @SalemAI mention)
 * /slot-scan command handler
 * Cycles through all 8 slot positions across all SIM banks
 * Each slot stays active for 3 minutes
 * Usage: /slot-scan
 */
app.command('/slot-scan', async ({ command, ack, respond }) => {
  await ack();

  // Check if a scan is already running
  if (slotScan.getActiveScan()) {
    respond({
      response_type: 'ephemeral',
      text: 'A slot scan is already in progress. Please wait for it to complete (~24 min).'
    });
    return;
  }

  // Check if sweep test is running
  if (sweepTest.getActiveTest()) {
    respond({
      response_type: 'ephemeral',
      text: 'A sweep test is in progress. Please wait for it to complete.'
    });
    return;
  }

  respond({
    response_type: 'ephemeral',
    text: `🔄 Slot scan starting... This will take ~24 minutes (8 slots × 3 min each)`
  });

  // Run the scan asynchronously
  setImmediate(() => {
    slotScan.runSlotScan(app).catch(error => {
      console.error('Slot scan failed:', error.message);
      app.client.chat.postMessage({
        channel: slotScan.TEST_CHANNEL_ID,
        text: `:x: Slot scan failed: ${error.message}`
      }).catch(e => console.error('Failed to post error message:', e.message));
    });
  });
});

/**
 * Message listener for "scan" command (works in DMs and channels)
 * Usage: scan
 * Triggers slot scan
 */
app.message(/^scan$/i, async ({ message, say }) => {
  // Ignore bot messages
  if (message.bot_id || message.subtype === 'bot_message') {
    return;
  }

  // Check if a scan is already running
  if (slotScan.getActiveScan()) {
    await say({
      text: '⚠️ A slot scan is already in progress. Please wait for it to complete (~24 min).',
      thread_ts: message.ts
    });
    return;
  }

  // Check if sweep test is running
  if (sweepTest.getActiveTest()) {
    await say({
      text: '⚠️ A sweep test is in progress. Please wait for it to complete.',
      thread_ts: message.ts
    });
    return;
  }

  console.log(`[SCAN] Triggered by user ${message.user} via message`);

  await say({
    text: '🔄 Starting slot scan... This will take ~24 minutes (8 slots × 3 min each)',
    thread_ts: message.ts
  });

  // Run the scan asynchronously
  setImmediate(() => {
    slotScan.runSlotScan(app).catch(error => {
      console.error('[SCAN] Failed:', error.message);
      app.client.chat.postMessage({
        channel: message.channel,
        thread_ts: message.ts,
        text: `:x: Slot scan failed: ${error.message}`
      }).catch(e => console.error('[SCAN] Failed to post error:', e.message));
    });
  });
});

/**
 * Message listener for "tm" command (without @Salem AI mention)
 * Usage: tm email@example.com
 * Triggers Ticketmaster code watch workflow
 */
app.message(/^tm\s+/i, async ({ message, say }) => {
  // Ignore bot messages
  if (message.bot_id || message.subtype === 'bot_message') {
    return;
  }

  // Ignore threaded replies (only respond to top-level messages)
  if (message.thread_ts && message.thread_ts !== message.ts) {
    return;
  }

  // Extract email - handle both raw email and Slack mailto link format
  const text = message.text.replace(/^tm\s+/i, '').trim();
  const emailMatch = text.match(/<mailto:([^|]+)\|[^>]+>/) || text.match(/^([^\s@]+@[^\s@]+\.[^\s@]+)$/i);

  if (!emailMatch) {
    await say({
      text: 'Usage: `tm <email>`\nExample: `tm user@example.com`',
      thread_ts: message.ts
    });
    return;
  }

  const email = emailMatch[1];
  console.log(`[TM] Triggered by user ${message.user} for email: ${email}`);

  // Reply in thread to acknowledge
  await say({
    text: `🎫 Starting Ticketmaster code watch for ${email}...\n_Searching Textchest + Gmail for 10 minutes_`,
    thread_ts: message.ts
  });

  // Start the Textchest+Gmail watch asynchronously
  setImmediate(() => {
    ticketmasterWatch.startTextchestWatch(app, email, message.channel, message.ts)
      .catch(error => {
        console.error('[TM] Textchest watch failed:', error.message);
        app.client.chat.postMessage({
          channel: message.channel,
          thread_ts: message.ts,
          text: `:x: Error: ${error.message}`
        }).catch(e => console.error('[TM] Failed to post error:', e.message));
      });
  });
});

/**
 * SIM Activation Channel Handler
 * When a phone number or email is posted in the activation channel,
 * look it up in Monday.com and activate the associated SIM
 */
app.message(async ({ message, say }) => {
  // Only process messages in the SIM activation channel
  if (message.channel !== SIM_ACTIVATE_CHANNEL_ID) {
    return;
  }

  // Ignore bot messages
  if (message.bot_id || message.subtype === 'bot_message') {
    return;
  }

  // Ignore threaded replies (only respond to top-level messages)
  if (message.thread_ts && message.thread_ts !== message.ts) {
    return;
  }

  const monday = require('./monday');
  const text = message.text.trim();

  // Detect if input is email or phone
  // Email: contains @ and looks like email format (handle Slack mailto links too)
  const emailMatch = text.match(/<mailto:([^|]+)\|[^>]+>/) || text.match(/^([^\s@]+@[^\s@]+\.[^\s@]+)$/i);

  // Phone: extract digits and check for 10-11 digit number
  // Handles: (555) 123-4567, 555-123-4567, 555.123.4567, +1 555 123 4567, 15551234567, etc.
  const digitsOnly = text.replace(/\D/g, '');
  let phoneMatch = null;

  // Check if we have a valid phone number (10 or 11 digits)
  if (digitsOnly.length === 10) {
    phoneMatch = digitsOnly;
  } else if (digitsOnly.length === 11 && digitsOnly.startsWith('1')) {
    phoneMatch = digitsOnly;
  } else if (digitsOnly.length === 12 && digitsOnly.startsWith('1')) {
    // Handle +1 prefix where + becomes nothing but space adds extra
    phoneMatch = digitsOnly.substring(1);
  }

  // Also try to extract phone from text that might have extra content
  // e.g., "Phone: (555) 123-4567" or "Call 555-123-4567"
  if (!phoneMatch && !emailMatch) {
    const phonePattern = /(?:\+?1[-.\s]?)?\(?([0-9]{3})\)?[-.\s]?([0-9]{3})[-.\s]?([0-9]{4})/;
    const extracted = text.match(phonePattern);
    if (extracted) {
      phoneMatch = extracted[1] + extracted[2] + extracted[3];
      // Add leading 1 if not present (normalize to 11 digits)
      if (phoneMatch.length === 10) {
        phoneMatch = '1' + phoneMatch;
      }
    }
  }

  if (!emailMatch && !phoneMatch) {
    // Not a recognizable email or phone, ignore
    return;
  }

  console.log(`[SIM ACTIVATE] Request in channel: ${text}`);

  // Add eyes reaction to show we're processing
  try {
    await app.client.reactions.add({
      channel: message.channel,
      timestamp: message.ts,
      name: 'eyes'
    });
  } catch (e) { /* ignore */ }

  let foundRecord = null;
  let searchType = '';
  let textchestNumber = null;

  try {
    if (emailMatch) {
      const email = emailMatch[1];
      searchType = 'email';
      console.log(`[SIM ACTIVATE] Searching by email: ${email}`);

      await say({
        text: `🔍 Searching for ${email}...`,
        thread_ts: message.ts
      });

      // Step 1: Try Textchest first
      textchestNumber = await textchest.findNumberByEmail(email);

      if (textchestNumber) {
        console.log(`[SIM ACTIVATE] Found in Textchest: ${textchestNumber.number}`);
        // Textchest has its own activation flow - handle it separately below
      } else {
        // Step 2: Try SS Email (Associates board)
        await say({
          text: `Not in Textchest. Checking Monday.com...`,
          thread_ts: message.ts
        });
        foundRecord = await monday.searchAssociateByEmail(email);

        // Step 3: If not found, try External Emails board
        if (!foundRecord) {
          foundRecord = await monday.searchExternalByEmail(email);
        }
      }
    } else if (phoneMatch) {
      // phoneMatch is already normalized to digits only
      searchType = 'phone';
      console.log(`[SIM ACTIVATE] Searching by phone: ${phoneMatch}`);

      await say({
        text: `🔍 Searching for ${formatPhoneDisplay(phoneMatch)}...`,
        thread_ts: message.ts
      });

      // Step 1: Try Textchest first
      textchestNumber = await textchest.findNumberByPhone(phoneMatch);

      if (!textchestNumber) {
        // Step 2: Search Associates board by phone
        await say({
          text: `Not in Textchest. Checking Monday.com...`,
          thread_ts: message.ts
        });
        foundRecord = await monday.searchAssociateByPhone(phoneMatch);
      }
    }

    // Handle Textchest flow (email or phone)
    if (textchestNumber) {
      const phoneDisplay = formatPhoneDisplay(textchestNumber.number);
      const emailInfo = textchestNumber.email ? `\nEmail: ${textchestNumber.email}` : '';
      await say({
        text: `✅ Found in Textchest\nPhone: ${phoneDisplay}${emailInfo}\n\n⚡ Activating...`,
        thread_ts: message.ts
      });

      try {
        const activateResult = await textchest.activateSim(textchestNumber.number);
        await say({
          text: `:white_check_mark: *Activated!*\nSlot: ${activateResult.slot}\n\n:eyes: Watching for SMS for 10 minutes...`,
          thread_ts: message.ts
        });
        await app.client.reactions.add({
          channel: message.channel,
          timestamp: message.ts,
          name: 'white_check_mark'
        }).catch(() => {});

        // Start watching for SMS to this number (normalize to 10 digits)
        const normalizedWatchPhone = normalizeToTenDigits(textchestNumber.number);
        const watchEndTime = Date.now() + SIM_WATCH_DURATION_MS;

        simActivationWatches.set(normalizedWatchPhone, {
          threadTs: message.ts,
          channel: message.channel,
          endTime: watchEndTime,
          name: textchestNumber.email || 'Textchest'
        });

        console.log(`[SIM ACTIVATE] Started 10-min watch for ${normalizedWatchPhone} (Textchest)`);
        return;
      } catch (err) {
        await say({
          text: `:warning: Activation failed: ${err.message}`,
          thread_ts: message.ts
        });
        await app.client.reactions.add({
          channel: message.channel,
          timestamp: message.ts,
          name: 'warning'
        }).catch(() => {});
        return;
      }
    }

    // Monday.com flow
    if (!foundRecord) {
      await say({
        text: `:x: Not found in Textchest or Monday.com`,
        thread_ts: message.ts
      });
      await app.client.reactions.add({
        channel: message.channel,
        timestamp: message.ts,
        name: 'x'
      }).catch(() => {});
      return;
    }

    const phoneDisplay = formatPhoneDisplay(foundRecord.phone);
    const emailInfo = foundRecord.email ? `\nEmail: ${foundRecord.email}` : '';
    await say({
      text: `✅ Found: *${foundRecord.name}*\nPhone: ${phoneDisplay}${emailInfo}\n\n🔍 Searching SIM banks...`,
      thread_ts: message.ts
    });

    // Find which SIM bank/slot has this phone
    const slotInfo = await simbank.findSlotByPhone(foundRecord.phone);

    if (!slotInfo) {
      await say({
        text: `:warning: Phone ${phoneDisplay} not found in any SIM bank`,
        thread_ts: message.ts
      });
      await app.client.reactions.add({
        channel: message.channel,
        timestamp: message.ts,
        name: 'warning'
      }).catch(() => {});
      return;
    }

    await say({
      text: `📍 Found in Bank ${slotInfo.bankId} · Slot ${slotInfo.slot}\nStatus: ${slotInfo.status.statusText}\n\n⚡ Activating...`,
      thread_ts: message.ts
    });

    // Activate the slot
    const bank = db.getSimBank(slotInfo.bankId);
    if (!bank) {
      await say({
        text: `:x: Bank ${slotInfo.bankId} not configured`,
        thread_ts: message.ts
      });
      return;
    }

    try {
      await simbank.activateSlot(bank, slotInfo.slot);
      await say({
        text: `:white_check_mark: *Activated!*\nBank ${slotInfo.bankId} · Slot ${slotInfo.slot}\n\n:eyes: Watching for SMS for 10 minutes...`,
        thread_ts: message.ts
      });
      await app.client.reactions.add({
        channel: message.channel,
        timestamp: message.ts,
        name: 'white_check_mark'
      }).catch(() => {});

      // Start watching for SMS to this number
      const normalizedWatchPhone = normalizeToTenDigits(foundRecord.phone);
      const watchEndTime = Date.now() + SIM_WATCH_DURATION_MS;

      simActivationWatches.set(normalizedWatchPhone, {
        threadTs: message.ts,
        channel: message.channel,
        endTime: watchEndTime,
        name: foundRecord.name
      });

      console.log(`[SIM ACTIVATE] Started 10-min watch for ${normalizedWatchPhone}`);

      // Set cleanup timer
      setTimeout(() => {
        const watch = simActivationWatches.get(normalizedWatchPhone);
        if (watch && watch.threadTs === message.ts) {
          simActivationWatches.delete(normalizedWatchPhone);
          app.client.chat.postMessage({
            channel: message.channel,
            thread_ts: message.ts,
            text: `:hourglass: Watch ended (10 minutes)`
          }).catch(() => {});
          console.log(`[SIM ACTIVATE] Watch ended for ${normalizedWatchPhone}`);
        }
      }, SIM_WATCH_DURATION_MS);

    } catch (activateErr) {
      await say({
        text: `:x: Activation failed: ${activateErr.message}`,
        thread_ts: message.ts
      });
      await app.client.reactions.add({
        channel: message.channel,
        timestamp: message.ts,
        name: 'x'
      }).catch(() => {});
    }

  } catch (error) {
    console.error('[SIM ACTIVATE] Error:', error.message);
    await say({
      text: `:x: Error: ${error.message}`,
      thread_ts: message.ts
    });
  }
});

/**
 * Post a Maxsip SMS message to Slack
 */
async function postMaxsipMessage(content, enrichment) {
  const { deals, senderStateName, senderPhoneFormatted, receiverPhoneFormatted } = enrichment;

  // Route verification codes to dedicated channel
  const targetChannel = isVerificationCode(content) ? VERIFICATION_CHANNEL_ID : CHANNEL_ID;

  let text = '';

  if (deals && deals.length > 0) {
    const monday = require('./monday');
    // Find the best matching deal (prioritize regional match)
    const bestDeal = findBestMatchingDeal(enrichment.senderAreaCode, deals);
    const regionMatch = checkAreaCodeMatch(enrichment.senderAreaCode, deals);
    const regionInfo = regionMatch ? '(matches region)' : '(not team region)';
    const senderState = monday.getStateFromAreaCode(enrichment.senderAreaCode);

    // Header: Associate name and receiver phone
    text += `📥 *New SMS to ${bestDeal.associateName}* · ${receiverPhoneFormatted}\n`;

    // From line with state and region match info
    text += `From: ${senderPhoneFormatted} · ${senderState || 'Unknown'} ${regionInfo}\n`;

    // Get closer Slack mention
    let closerMention = '';
    if (bestDeal.closer) {
      const closerSlackId = monday.getCloserSlackId(bestDeal.closer);
      closerMention = closerSlackId ? ` <@${closerSlackId}>` : ` @${bestDeal.closer}`;
    }

    // Deal line(s) - show best matching deal prominently
    if (deals.length === 1) {
      text += `Deal: ${bestDeal.team} (${bestDeal.status})${closerMention}\n`;
    } else {
      // Show best match first, then list others
      const otherDeals = deals.filter(d => d !== bestDeal).map(d => `${d.team} (${d.status})`).join(', ');
      text += `Deal: ${bestDeal.team} (${bestDeal.status})${closerMention}\n`;
      text += `_Other deals: ${otherDeals}_\n`;
    }

    text += '\n';
    text += `"${content}"\n\n`;
    text += `_Reply: https://manage.maxsip.com/SMS/Chat.aspx (select ${receiverPhoneFormatted})_`;
  } else {
    // Format without deal info
    text += `📥 *New SMS to ${receiverPhoneFormatted}*\n`;
    text += `From: ${senderPhoneFormatted} · ${senderStateName || 'Unknown'}\n\n`;
    text += `"${content}"\n\n`;
    text += `_Reply: https://manage.maxsip.com/SMS/Chat.aspx (select ${receiverPhoneFormatted})_`;
  }

  const blocks = [{
    type: 'section',
    text: { type: 'mrkdwn', text }
  }];

  await app.client.chat.postMessage({
    channel: targetChannel,
    text: `New Maxsip SMS to ${receiverPhoneFormatted}`,
    blocks
  });
}

module.exports = {
  app,
  receiver,
  postNewConversation,
  postInboundToThread,
  postOutboundToThread,
  postSpamMessage,
  postMaxsipMessage,
  addReaction,
  isVerificationCode,
  checkSimActivationWatch,
  CHANNEL_ID
};

/**
 * Check if there's an active SIM activation watch for this phone and post SMS to thread
 * @param {string} recipientPhone - The receiving phone number (our SIM)
 * @param {string} senderPhone - The sender's phone number
 * @param {string} content - Message content
 * @returns {boolean} - True if message was posted to a watch thread
 */
async function checkSimActivationWatch(recipientPhone, senderPhone, content) {
  // Normalize to 10 digits (same format as stored keys)
  const normalizedPhone = normalizeToTenDigits(recipientPhone);

  console.log(`[SIM ACTIVATE] Checking watch for recipient: ${recipientPhone} -> normalized: ${normalizedPhone}`);
  console.log(`[SIM ACTIVATE] Active watches: ${Array.from(simActivationWatches.keys()).join(', ') || 'none'}`);

  const watch = simActivationWatches.get(normalizedPhone);
  if (watch && Date.now() < watch.endTime) {
    const senderDisplay = formatPhoneDisplay(senderPhone);

    try {
      await app.client.chat.postMessage({
        channel: watch.channel,
        thread_ts: watch.threadTs,
        text: `📨 *SMS Received*\nFrom: ${senderDisplay}\n\n> ${content}`
      });
      console.log(`[SIM ACTIVATE] Posted SMS to watch thread for ${normalizedPhone}`);
      return true;
    } catch (err) {
      console.error(`[SIM ACTIVATE] Failed to post to thread: ${err.message}`);
    }
  }

  return false;
}
