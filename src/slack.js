const { App, ExpressReceiver } = require('@slack/bolt');
const db = require('./database');
const simbank = require('./simbank');
const { formatPhoneDisplay, parsePhoneFromCommand, formatTime } = require('./utils');
const { trackOutboundSms } = require('./deliveryTracker');
const sweepTest = require('./sweepTest');
const ticketmasterWatch = require('./ticketmasterWatch');

const CHANNEL_ID = process.env.SLACK_CHANNEL_ID;
const SPAM_CHANNEL_ID = 'C0A1EUF2D36';
const VERIFICATION_CHANNEL_ID = 'C05KCUMN35M';

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

  return false;
}

// Approved Slack user IDs who can send SMS via @SalemAI command
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
    text += `\nReceived: ${timestamp}\n\n_Reply: @SalemAI ${bankId} ${port} followed by your message_`;
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
    text += `_Reply: @SalemAI reply ${bankId} ${port} followed by your message_`;
  } else {
    // Format without deal info
    text += `📥 *New SMS to ${receiverPhoneFormatted}*\n`;
    text += `From: ${senderPhoneFormatted} · ${senderStateName || 'Unknown'}\n\n`;
    text += `"${content}"\n\n`;
    text += `_Reply: @SalemAI reply ${bankId} ${port} followed by your message_`;
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

  // Route verification codes to dedicated channel
  const targetChannel = isVerificationCode(content) ? VERIFICATION_CHANNEL_ID : CHANNEL_ID;

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

  const result = await app.client.chat.postMessage({
    channel: targetChannel,
    thread_ts: threadTs,
    reply_broadcast: true,
    text: `New message from ${formatPhoneDisplay(senderPhone)}`,
    blocks
  });

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
    const messagePreview = (content.length > 300 ? content.substring(0, 300) + '...' : content)
      .replace(/\n+/g, ' ')
      .replace(/\*/g, '✱');
    let parentText = `🚫 *${messagePreview}*\n\n`;
    parentText += `_${existingThread.count} recipients · ${senderDisplay} · ${senderState || 'Unknown'}`;
    if (bankId === 'maxsip') {
      parentText += ` · Maxsip`;
    }
    parentText += ` · ${spamResult.category || 'Spam'}_`;

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
    // Create new parent message - message text is the hero
    // Replace newlines with spaces and escape asterisks to prevent markdown breaking
    const messagePreview = (content.length > 300 ? content.substring(0, 300) + '...' : content)
      .replace(/\n+/g, ' ')
      .replace(/\*/g, '✱');

    let text = `🚫 *${messagePreview}*\n\n`;
    text += `_${senderDisplay} → ${recipientDisplay} · ${senderState || 'Unknown'}`;
    if (bankId === 'maxsip') {
      text += ` · Maxsip`;
    } else if (bankId) {
      text += ` · Bank ${bankId}`;
    }
    text += ` · ${spamResult.category || 'Spam'}_`;

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
 * @SalemAI mention handler
 * Commands:
 * - @SalemAI tm <email> - Watch for Ticketmaster codes (SMS + Email)
 * - @SalemAI reply <bank> <slot> <message> - Send SMS reply (in thread)
 * - @SalemAI status <bank> <slot> - Check SIM slot status
 */
app.event('app_mention', async ({ event, say }) => {
  await addReaction(event.channel, event.ts, 'eyes');

  // Parse the command text
  const fullText = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
  const parts = fullText.split(/\s+/);

  // Check if this is a status command
  if (parts[0]?.toLowerCase() === 'status') {
    const bankId = parts[1];
    const slot = parts[2];

    if (!bankId || !slot) {
      await say({
        text: 'Usage: `@SalemAI status [bank] [slot]`\nExample: `@SalemAI status 50004 4.07`',
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

  // Check if this is a Ticketmaster code watch: @SalemAI tm <email>
  if (parts[0]?.toLowerCase() === 'tm') {
    // Extract email - Slack auto-links as <mailto:user@example.com|user@example.com>
    const restOfText = fullText.replace(/^tm\s+/i, '');
    const emailMatch = restOfText.match(/<mailto:([^|]+)\|[^>]+>/) || restOfText.match(/^([^\s@]+@[^\s@]+\.[^\s@]+)$/i);

    if (!emailMatch) {
      await say({
        text: 'Usage: `@SalemAI tm <email>`\nExample: `@SalemAI tm user@example.com`',
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

  // Check if this is an SMS reply: @SalemAI reply <bank> <slot> <message>
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
        text: 'Please use `@SalemAI reply` in a conversation thread.\nUsage: `@SalemAI reply <bank> <slot> <message>`\nExample: `@SalemAI reply 50004 4.07 Hello there`',
        thread_ts: event.ts
      });
      return;
    }

    // Parse: @SalemAI reply [bank] [slot] [message]
    const specifiedBank = parts[1];
    const specifiedSlot = parts[2];
    const message = parts.slice(3).join(' ');

    // Validate bank format (e.g., "50004")
    if (!specifiedBank || !/^\d{5}$/.test(specifiedBank)) {
      await say({
        text: `Invalid format. Bank ID is required (5 digits).\nUsage: \`@SalemAI reply <bank> <slot> <message>\`\nExample: \`@SalemAI reply 50004 4.07 Hello there\``,
        thread_ts: event.thread_ts
      });
      return;
    }

    // Validate slot format (e.g., "4.07", "1.01")
    if (!specifiedSlot || !/^\d+\.\d+$/.test(specifiedSlot)) {
      await say({
        text: `Invalid format. Slot is required.\nUsage: \`@SalemAI reply <bank> <slot> <message>\`\nExample: \`@SalemAI reply ${specifiedBank} 4.07 Hello there\``,
        thread_ts: event.thread_ts
      });
      return;
    }

    if (!message) {
      await say({
        text: `Message is required.\nUsage: \`@SalemAI reply ${specifiedBank} ${specifiedSlot} <message>\``,
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
    text: `*@SalemAI Commands:*\n• \`@SalemAI tm <email>\` - Watch for Ticketmaster codes\n• \`@SalemAI reply <bank> <slot> <message>\` - Send SMS reply (in thread)\n• \`@SalemAI status <bank> <slot>\` - Check SIM slot status`,
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
 * Usage: /sweep-test
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

  // Respond immediately - don't await
  respond({
    response_type: 'ephemeral',
    text: `🧪 Sweep test starting...`
  });

  // Run the test fully asynchronously in the background
  const bankId = '50004';
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
 * Message listener for tmcode keyword trigger
 * Usage: tmcode email@example.com
 * Triggers Ticketmaster code watch workflow
 */
app.message(/^tmcode\s+([^\s@]+@[^\s@]+\.[^\s@]+)/i, async ({ message, context, say }) => {
  // Ignore bot messages
  if (message.bot_id || message.subtype === 'bot_message') {
    return;
  }

  // Ignore threaded replies (only respond to top-level messages)
  if (message.thread_ts && message.thread_ts !== message.ts) {
    return;
  }

  const email = context.matches[1];
  console.log(`[TMCODE] Triggered by user ${message.user} for email: ${email}`);

  // Reply in thread to acknowledge
  const reply = await say({
    text: `Starting Ticketmaster code watch for ${email}...`,
    thread_ts: message.ts
  });

  // Start the watch workflow asynchronously
  setImmediate(() => {
    ticketmasterWatch.startTicketmasterWatch(app, email, message.channel, message.ts)
      .catch(error => {
        console.error('[TMCODE] Watch failed:', error.message);
        app.client.chat.postMessage({
          channel: message.channel,
          thread_ts: message.ts,
          text: `:x: Error: ${error.message}`
        }).catch(e => console.error('[TMCODE] Failed to post error:', e.message));
      });
  });
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
  CHANNEL_ID
};
