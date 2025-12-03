const { App, ExpressReceiver } = require('@slack/bolt');
const db = require('./database');
const simbank = require('./simbank');
const { formatPhoneDisplay, parsePhoneFromCommand, formatTime } = require('./utils');
const { trackOutboundSms } = require('./deliveryTracker');
const sweepTest = require('./sweepTest');

const CHANNEL_ID = process.env.SLACK_CHANNEL_ID;
const SPAM_CHANNEL_ID = 'C0A11NU1JDT';
const VERIFICATION_CHANNEL_ID = 'C05KCUMN35M';

/**
 * Check if message contains a verification code from known services
 * Returns true if message should be routed to verification channel
 * Check this BEFORE spam filter - these messages skip spam filtering
 */
function isVerificationCode(content) {
  if (!content) return false;
  const text = content.toLowerCase();

  // Google verification codes: G- followed by 6 digits
  if (/g-\d{6}/i.test(content)) return true;

  // Google with code/verification keywords
  if (text.includes('google') && (text.includes('code') || text.includes('verification'))) return true;

  // Ticketing services
  if (text.includes('ticketmaster')) return true;
  if (text.includes('stubhub')) return true;
  if (text.includes('seatgeek')) return true;
  if (text.includes('vivid seats')) return true;
  if (text.includes('axs')) return true;

  // Email providers
  if (text.includes('gmail')) return true;
  if (text.includes('microsoft')) return true;
  if (text.includes('yahoo')) return true;
  if (text.includes('outlook')) return true;

  return false;
}

// Approved Slack user IDs who can send SMS via @SMS command
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
    text += `\nReceived: ${timestamp}\n\n_Reply: @SMS ${bankId} ${port} followed by your message_`;
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
 * Build enriched SMS message blocks with Monday.com deal info
 */
function buildEnrichedSmsBlocks({ content, bankId, port, enrichment, iccid }) {
  const monday = require('./monday');
  const { deals, senderAreaCode, senderStateName, senderPhoneFormatted, receiverPhoneFormatted } = enrichment;

  let text = '';

  if (deals && deals.length > 0) {
    // Format with deal info
    const firstDeal = deals[0];
    const regionMatch = checkAreaCodeMatch(senderAreaCode, deals);
    const regionInfo = regionMatch ? '(matches region)' : '(not team region)';
    const monday = require('./monday');
    const senderState = monday.getStateFromAreaCode(senderAreaCode);

    // Header: Associate name and receiver phone
    text += `📥 *New SMS to ${firstDeal.associateName}* · ${receiverPhoneFormatted}\n`;

    // From line with state and region match info
    text += `From: ${senderPhoneFormatted} · ${senderState || 'Unknown'} ${regionInfo}\n`;

    // Get closer Slack mention
    let closerMention = '';
    if (firstDeal.closer) {
      const closerSlackId = monday.getCloserSlackId(firstDeal.closer);
      closerMention = closerSlackId ? ` <@${closerSlackId}>` : ` @${firstDeal.closer}`;
    }

    // Deal line(s)
    if (deals.length === 1) {
      text += `Deal: ${firstDeal.team} (${firstDeal.status})${closerMention}\n`;
    } else {
      const dealSummary = deals.map(d => `${d.team} (${d.status})`).join(', ');
      text += `Deals: ${dealSummary}${closerMention}\n`;
    }

    text += '\n';
    text += `"${content}"\n\n`;
    text += `_Reply: @SMS ${bankId} ${port} followed by your message_`;
  } else {
    // Format without deal info
    text += `📥 *New SMS to ${receiverPhoneFormatted}*\n`;
    text += `From: ${senderPhoneFormatted} · ${senderStateName || 'Unknown'}\n\n`;
    text += `"${content}"\n\n`;
    text += `_Reply: @SMS ${bankId} ${port} followed by your message_`;
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
 * Post a spam message to the spam channel
 */
async function postSpamMessage(senderPhone, recipientPhone, content, spamResult, bankId, slot) {
  const monday = require('./monday');
  const senderDisplay = formatPhoneDisplay(senderPhone);
  const recipientDisplay = formatPhoneDisplay(recipientPhone);

  // Get sender state from area code
  const senderAreaCode = monday.getAreaCodeFromPhone(senderPhone);
  const senderState = monday.getStateFromAreaCode(senderAreaCode);

  // Truncate message for preview
  const messagePreview = content.length > 200 ? content.substring(0, 200) + '...' : content;

  let text = `🚫 *Spam Blocked*\n`;
  text += `From: ${senderDisplay} · ${senderState || 'Unknown'}\n`;
  text += `To: ${recipientDisplay}\n`;

  if (bankId === 'maxsip') {
    text += `Source: Maxsip\n`;
  } else if (bankId) {
    text += `Bank: ${bankId} · Slot: ${slot || 'unknown'}\n`;
  }

  text += `Category: ${spamResult.category || 'Unknown'}\n`;
  text += `\n"${messagePreview}"`;

  await app.client.chat.postMessage({
    channel: SPAM_CHANNEL_ID,
    text,
    unfurl_links: false,
    unfurl_media: false
  });
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
 * App mention handler for thread replies and status checks
 * Usage: @SMS [port] [message] - Send SMS
 * Usage: @SMS status [bank] [slot] - Check slot status
 * Example: @SMS 4.07 Hello there
 * Example: @SMS status 50004 4.07
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
        text: 'Usage: `@SMS status [bank] [slot]`\nExample: `@SMS status 50004 4.07`',
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
      text: 'Please use @SMS in a conversation thread.\nUsage: `@SMS <bank> <slot> <your message>`\nExample: `@SMS 50004 4.07 Hello there`',
      thread_ts: event.ts
    });
    return;
  }

  // Parse: @SMS [bank] [slot] [message]
  const specifiedBank = parts[0];
  const specifiedSlot = parts[1];
  const message = parts.slice(2).join(' ');

  // Validate bank format (e.g., "50004")
  if (!specifiedBank || !/^\d{5}$/.test(specifiedBank)) {
    await say({
      text: `Invalid format. Bank ID is required (5 digits).\nUsage: \`@SMS <bank> <slot> <your message>\`\nExample: \`@SMS 50004 4.07 Hello there\``,
      thread_ts: event.thread_ts
    });
    return;
  }

  // Validate slot format (e.g., "4.07", "1.01")
  if (!specifiedSlot || !/^\d+\.\d+$/.test(specifiedSlot)) {
    await say({
      text: `Invalid format. Slot is required.\nUsage: \`@SMS <bank> <slot> <your message>\`\nExample: \`@SMS ${specifiedBank} 4.07 Hello there\``,
      thread_ts: event.thread_ts
    });
    return;
  }

  if (!message) {
    await say({
      text: `Message is required.\nUsage: \`@SMS ${specifiedBank} ${specifiedSlot} <your message>\``,
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
  await ack();

  // Check if a test is already running
  if (sweepTest.getActiveTest()) {
    await respond({
      response_type: 'ephemeral',
      text: 'A sweep test is already in progress. Please wait for it to complete.'
    });
    return;
  }

  const bankId = '50004';

  await respond({
    response_type: 'ephemeral',
    text: `Starting sweep test for bank ${bankId}. This will take approximately 3 minutes. Results will be posted to <#${sweepTest.TEST_CHANNEL_ID}>.`
  });

  try {
    // Run the test asynchronously (don't await - let it run in background)
    sweepTest.runSweepTest(app, bankId).catch(error => {
      console.error('Sweep test failed:', error.message);
      app.client.chat.postMessage({
        channel: sweepTest.TEST_CHANNEL_ID,
        text: `:x: Sweep test failed: ${error.message}`
      }).catch(e => console.error('Failed to post error message:', e.message));
    });
  } catch (error) {
    console.error('Failed to start sweep test:', error.message);
    await respond({
      response_type: 'ephemeral',
      text: `Failed to start sweep test: ${error.message}`
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
    const firstDeal = deals[0];
    const regionMatch = monday.doesAreaCodeMatchTeam(
      enrichment.senderAreaCode,
      firstDeal.team
    ).matches;
    const regionInfo = regionMatch ? '(matches region)' : '(not team region)';
    const senderState = monday.getStateFromAreaCode(enrichment.senderAreaCode);

    // Header: Associate name and receiver phone
    text += `📥 *New SMS to ${firstDeal.associateName}* · ${receiverPhoneFormatted}\n`;

    // From line with state and region match info
    text += `From: ${senderPhoneFormatted} · ${senderState || 'Unknown'} ${regionInfo}\n`;

    // Get closer Slack mention
    let closerMention = '';
    if (firstDeal.closer) {
      const closerSlackId = monday.getCloserSlackId(firstDeal.closer);
      closerMention = closerSlackId ? ` <@${closerSlackId}>` : ` @${firstDeal.closer}`;
    }

    // Deal line(s)
    if (deals.length === 1) {
      text += `Deal: ${firstDeal.team} (${firstDeal.status})${closerMention}\n`;
    } else {
      const dealSummary = deals.map(d => `${d.team} (${d.status})`).join(', ');
      text += `Deals: ${dealSummary}${closerMention}\n`;
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
