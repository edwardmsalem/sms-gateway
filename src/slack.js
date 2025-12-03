const { App, ExpressReceiver } = require('@slack/bolt');
const db = require('./database');
const simbank = require('./simbank');
const { formatPhoneDisplay, parsePhoneFromCommand, formatTime } = require('./utils');
const { trackOutboundSms } = require('./deliveryTracker');

const CHANNEL_ID = process.env.SLACK_CHANNEL_ID;
const SPAM_CHANNEL_ID = 'C0A11NU1JDT';

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
 * Build SMS message blocks for Slack
 */
function buildSmsBlocks({ recipientDisplay, senderDisplay, content, bankId, port, timestamp, isOutbound, sentBy }) {
  const icon = isOutbound ? '📤' : '📨';
  const title = isOutbound ? 'Outgoing SMS' : `New SMS to ${recipientDisplay}`;

  let text = `${icon} *${title}*\n━━━━━━━━━━━━━━━━━━━━━━━\n💬 ${content}\n━━━━━━━━━━━━━━━━━━━━━━━\n`;

  if (isOutbound) {
    text += `To: ${senderDisplay}\nFrom: ${recipientDisplay}`;
    if (bankId) text += `\n📍 Bank ${bankId} · Port ${port}`;
    text += `\nSent by: <@${sentBy}> | ${timestamp}`;
  } else {
    text += `From: ${senderDisplay}\n📍 *Bank ${bankId} · Slot ${port}*\nReceived: ${timestamp}\n\n_Reply: @SMS ${bankId} ${port} followed by your message_`;
  }

  return [{
    type: 'section',
    text: { type: 'mrkdwn', text }
  }];
}

/**
 * Post a new conversation to Slack channel
 */
async function postNewConversation(conversation, messageContent) {
  const result = await app.client.chat.postMessage({
    channel: CHANNEL_ID,
    text: `New SMS to ${formatPhoneDisplay(conversation.recipient_phone)}`,
    blocks: buildSmsBlocks({
      recipientDisplay: formatPhoneDisplay(conversation.recipient_phone),
      senderDisplay: formatPhoneDisplay(conversation.sender_phone),
      content: messageContent,
      bankId: conversation.sim_bank_id,
      port: conversation.sim_port,
      timestamp: formatTime(),
      isOutbound: false
    })
  });

  return result.ts;
}

/**
 * Post an inbound message to existing thread
 * Returns { postedTs, actualThreadTs }
 */
async function postInboundToThread(threadTs, senderPhone, recipientPhone, content, conversation) {
  const result = await app.client.chat.postMessage({
    channel: CHANNEL_ID,
    thread_ts: threadTs,
    reply_broadcast: true,
    text: `New message from ${formatPhoneDisplay(senderPhone)}`,
    blocks: buildSmsBlocks({
      recipientDisplay: formatPhoneDisplay(recipientPhone),
      senderDisplay: formatPhoneDisplay(senderPhone),
      content,
      bankId: conversation?.sim_bank_id || 'unknown',
      port: conversation?.sim_port || 'PORT',
      timestamp: formatTime(),
      isOutbound: false
    })
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
  const senderDisplay = formatPhoneDisplay(senderPhone);
  const recipientDisplay = formatPhoneDisplay(recipientPhone);

  let text = `:no_entry: *SPAM BLOCKED*\n`;
  text += `━━━━━━━━━━━━━━━━━━━━━━━\n`;
  text += `*Category:* ${spamResult.category || 'Unknown'}\n`;
  text += `*Confidence:* ${spamResult.confidence}\n`;
  text += `━━━━━━━━━━━━━━━━━━━━━━━\n`;
  text += `From: ${senderDisplay}\n`;
  text += `To: ${recipientDisplay}\n`;
  if (bankId) text += `Bank ${bankId} · Slot ${slot || 'unknown'}\n`;
  text += `━━━━━━━━━━━━━━━━━━━━━━━\n`;
  text += `${content}`;

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

module.exports = {
  app,
  receiver,
  postNewConversation,
  postInboundToThread,
  postOutboundToThread,
  postSpamMessage,
  addReaction,
  CHANNEL_ID
};
