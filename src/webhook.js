const express = require('express');
const crypto = require('crypto');
const db = require('./database');
const slack = require('./slack');
const { normalizePhone } = require('./utils');
const { getPendingDelivery, clearPendingDelivery } = require('./deliveryTracker');
const { updateLastKnownSlot, getSlotStatus } = require('./simbank');
const { classifyMessage } = require('./spamFilter');
const monday = require('./monday');
const sweepTest = require('./sweepTest');
const slotScan = require('./slotScan');
const ticketmasterWatch = require('./ticketmasterWatch');

// Message deduplication - track recently processed messages to prevent duplicates
// Key: hash of sender+recipient+content, Value: timestamp
const recentMessages = new Map();
const DEDUPE_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Generate a deduplication key for a message
 */
function getMessageKey(sender, recipient, content) {
  const data = `${sender}|${recipient}|${content}`;
  return crypto.createHash('md5').update(data).digest('hex');
}

/**
 * Check if message is a duplicate (seen within dedupe window)
 * Returns true if duplicate, false if new
 */
function isDuplicateMessage(sender, recipient, content) {
  const key = getMessageKey(sender, recipient, content);
  const now = Date.now();

  // Clean up old entries periodically (every 100 checks)
  if (recentMessages.size > 100) {
    for (const [k, timestamp] of recentMessages) {
      if (now - timestamp > DEDUPE_WINDOW_MS) {
        recentMessages.delete(k);
      }
    }
  }

  if (recentMessages.has(key)) {
    const lastSeen = recentMessages.get(key);
    if (now - lastSeen < DEDUPE_WINDOW_MS) {
      return true; // Duplicate
    }
  }

  recentMessages.set(key, now);
  return false; // New message
}

/**
 * Format phone number for display
 */
function formatPhone(phone) {
  const digits = phone.replace(/\D/g, '');
  const num = digits.startsWith('1') && digits.length === 11 ? digits.substring(1) : digits;
  if (num.length === 10) {
    return `(${num.substring(0, 3)}) ${num.substring(3, 6)}-${num.substring(6)}`;
  }
  return phone;
}

/**
 * Check if sender is a short code (5-6 digits)
 */
function isShortCode(phone) {
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 5 && digits.length <= 6;
}

const router = express.Router();

/**
 * Parse Ejoin SIM bank body format
 * Returns { content, slot }
 *
 * Body format:
 *   Sender: 17184906444
 *   Receiver: "4.07" 15132896015
 *   SMSC: 14054724068
 *   SCTS: 251130192726B2
 *   Slot: "07"
 *
 *   Message content here
 */
function parseEjoinBody(bodyStr) {
  const lines = bodyStr.split(/\r?\n/);
  const metadataPrefixes = ['Sender:', 'Receiver:', 'SMSC:', 'SCTS:', 'Slot:'];

  let slot = null;
  const contentLines = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    // Extract slot from Receiver line: Receiver: "4.07" 15132896015
    if (trimmed.startsWith('Receiver:')) {
      const slotMatch = trimmed.match(/Receiver:\s*"([^"]+)"/);
      if (slotMatch) {
        slot = slotMatch[1];
      }
      continue;
    }

    const isMetadata = metadataPrefixes.some(prefix => trimmed.startsWith(prefix));
    if (!isMetadata) {
      contentLines.push(trimmed);
    }
  }

  return { content: contentLines.join('\n').trim() || null, slot };
}

/**
 * Parse body from request - handles Buffer, string, or object
 */
function parseRequestBody(req) {
  let content = req.query.content;
  let slot = null;

  if (Buffer.isBuffer(req.body)) {
    const parsed = parseEjoinBody(req.body.toString('utf8'));
    content = parsed.content;
    slot = parsed.slot;
  } else if (typeof req.body === 'string') {
    const parsed = parseEjoinBody(req.body);
    content = parsed.content;
    slot = parsed.slot;
  } else if (req.body && typeof req.body === 'object') {
    content = content || req.body.content;
  }

  return { content, slot };
}

/**
 * Clean bank ID from query params (handles malformed query strings)
 */
function parseBankId(req) {
  let bank = req.query.bank || 'unknown';
  if (bank.includes('?')) {
    bank = bank.split('?')[0];
  }
  return bank;
}

/**
 * Process delivery report (DRPT) message
 * Returns true if processed as delivery report
 */
async function processDeliveryReport(content) {
  if (!content.startsWith('DRPT:')) {
    return false;
  }

  // Extract phone number from content like "DRPT: 0 9297533703\nSms Send to 9297533703 Success"
  const phoneMatch = content.match(/(\d{10,15})/);
  if (!phoneMatch) {
    return true; // Was a DRPT but couldn't parse phone
  }

  const deliveryPhone = phoneMatch[1];
  const pending = getPendingDelivery(deliveryPhone);

  if (pending) {
    const isSuccess = content.toLowerCase().includes('success');
    const emoji = isSuccess ? 'white_check_mark' : 'x';

    try {
      await slack.addReaction(pending.channel, pending.ts, emoji);
    } catch (err) {
      console.error(`Failed to add delivery reaction: ${err.message}`);
    }

    clearPendingDelivery(deliveryPhone);
  }

  return true;
}

/**
 * Inbound SMS webhook
 * Receives POST from Ejoin SIM banks
 *
 * Query params: bank, sender, receiver
 * Body: Ejoin text format with slot in Receiver line
 */
router.post('/sms', async (req, res) => {
  try {
    const { content, slot } = parseRequestBody(req);
    const sender = req.query.sender || req.body?.sender;
    const receiver = req.query.receiver || req.body?.receiver;
    const bank = parseBankId(req);

    // Validate required fields
    if (!sender || !receiver || !content) {
      console.warn('Missing required fields:', { sender: !!sender, receiver: !!receiver, content: !!content });
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Normalize phone numbers
    const senderPhone = normalizePhone(sender);
    const recipientPhone = normalizePhone(receiver);

    if (!senderPhone || !recipientPhone) {
      console.warn('Invalid phone numbers:', { sender, receiver });
      return res.status(400).json({ error: 'Invalid phone numbers' });
    }

    // Track the active slot for this bank-channel
    if (slot) {
      updateLastKnownSlot(bank, slot);
    }

    // Handle delivery reports
    if (await processDeliveryReport(content)) {
      return res.status(200).json({ status: 'delivery_report_processed' });
    }

    // Check for duplicate messages (same sender+recipient+content within 5 min)
    if (isDuplicateMessage(senderPhone, recipientPhone, content)) {
      console.log(`[DEDUPE] Skipping duplicate message from ${senderPhone} to ${recipientPhone}`);
      return res.status(200).json({ status: 'duplicate_skipped' });
    }

    // Check if sender is blocked
    if (db.isNumberBlocked(senderPhone)) {
      return res.status(200).json({ status: 'blocked' });
    }

    // Check for verification codes FIRST - skip spam filter for these
    const isVerification = slack.isVerificationCode(content);
    if (isVerification) {
      console.log(`[VERIFICATION] Detected verification code, skipping spam filter`);
    }

    // Filter short codes as spam (unless verification code)
    if (!isVerification && isShortCode(senderPhone)) {
      console.log(`[SPAM BLOCKED] Short code filtered: ${senderPhone}`);
      await slack.postSpamMessage(senderPhone, recipientPhone, content, { spam: true, category: 'Short Code', confidence: 'high' }, bank, slot);
      sweepTest.recordMessageArrival('spam', slot);
      slotScan.recordMessageArrival('spam', bank, slot);
      return res.status(200).json({ status: 'spam_filtered', category: 'Short Code' });
    }

    // Check for spam using Claude (skip if verification code)
    if (!isVerification) {
      const spamResult = await classifyMessage(content, senderPhone);
      if (spamResult.spam) {
        console.log(`[SPAM BLOCKED] From ${senderPhone}: category=${spamResult.category}, confidence=${spamResult.confidence}`);
        await slack.postSpamMessage(senderPhone, recipientPhone, content, spamResult, bank, slot);
        // Track for sweep test / slot scan if active
        sweepTest.recordMessageArrival('spam', slot);
        slotScan.recordMessageArrival('spam', bank, slot);
        return res.status(200).json({ status: 'spam_filtered', category: spamResult.category });
      }
    }

    // Get ICCID from slot status
    let iccid = null;
    if (bank && slot) {
      try {
        const slotStatus = await getSlotStatus(bank, slot);
        if (!slotStatus.error && slotStatus.iccid) {
          iccid = slotStatus.iccid;
          console.log(`[ICCID] Bank ${bank} Slot ${slot}: ${iccid}`);
        }
      } catch (err) {
        console.warn(`[ICCID] Failed to get ICCID: ${err.message}`);
      }
    }

    // Look up deals from Monday.com using recipient phone (our SIM = associate's number)
    // Sender area code tells us where the person texting is from
    let deals = [];
    let senderAreaCode = null;
    let senderState = null;
    let senderStateName = null;
    try {
      deals = await monday.lookupDealsByPhone(recipientPhone);
      senderAreaCode = monday.getAreaCodeFromPhone(senderPhone);
      senderState = monday.getStateFromAreaCode(senderAreaCode);
      senderStateName = monday.STATE_NAMES[senderState] || senderState;
      console.log(`[MONDAY] Found ${deals.length} deals for recipient ${recipientPhone}, sender from ${senderStateName || 'Unknown'}`);
    } catch (err) {
      console.warn(`[MONDAY] Lookup failed: ${err.message}`);
    }

    // Build enrichment data for Slack
    const enrichment = {
      deals,
      senderAreaCode,
      senderState,
      senderStateName,
      senderPhoneFormatted: formatPhone(senderPhone),
      receiverPhoneFormatted: formatPhone(recipientPhone)
    };

    // Find or create conversation
    let conversation = db.findConversation(senderPhone, recipientPhone);
    let isNewConversation = false;

    if (!conversation) {
      conversation = db.createConversation({
        sender_phone: senderPhone,
        recipient_phone: recipientPhone,
        sim_bank_id: bank,
        sim_port: slot || 'unknown',
        slack_channel_id: process.env.SLACK_CHANNEL_ID,
        slack_thread_ts: null,
        iccid: iccid
      });

      if (!conversation) {
        console.error('Failed to create conversation');
        return res.status(500).json({ error: 'Failed to create conversation' });
      }

      isNewConversation = !conversation.slack_thread_ts;
    } else if (iccid && conversation.iccid !== iccid) {
      // Update ICCID if it changed
      db.updateConversationIccid(conversation.id, iccid);
      conversation.iccid = iccid;
    }

    // Record the message
    db.insertMessage({
      conversation_id: conversation.id,
      direction: 'inbound',
      content: content,
      sent_by_slack_user: null,
      status: 'received'
    });

    // Post to Slack
    if (isNewConversation || !conversation.slack_thread_ts) {
      const threadTs = await slack.postNewConversation(conversation, content, enrichment);
      db.updateConversationThread(threadTs, conversation.id);
    } else {
      const { actualThreadTs } = await slack.postInboundToThread(
        conversation.slack_thread_ts,
        senderPhone,
        recipientPhone,
        content,
        conversation,
        enrichment
      );

      if (actualThreadTs && actualThreadTs !== conversation.slack_thread_ts) {
        db.updateConversationThread(actualThreadTs, conversation.id);
      } else {
        db.updateConversationTimestamp(conversation.id);
      }
    }

    // Track for sweep test / slot scan if active
    const channelType = isVerification ? 'verification' : 'sms';
    sweepTest.recordMessageArrival(channelType, slot);
    slotScan.recordMessageArrival(channelType, bank, slot);

    // Check for active Ticketmaster watch and notify if message contains "Ticketmaster"
    ticketmasterWatch.checkWatchAndNotify(recipientPhone, senderPhone, content, slack.app);

    // Check for active SIM activation watch and post to thread
    slack.checkSimActivationWatch(recipientPhone, senderPhone, content);

    res.status(200).json({ status: 'ok' });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Health check endpoint
 */
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString()
  });
});

module.exports = { router };
