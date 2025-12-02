const express = require('express');
const db = require('./database');
const slack = require('./slack');
const { normalizePhone } = require('./utils');
const { getPendingDelivery, clearPendingDelivery } = require('./deliveryTracker');

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

    // Handle delivery reports
    if (await processDeliveryReport(content)) {
      return res.status(200).json({ status: 'delivery_report_processed' });
    }

    // Check if sender is blocked
    if (db.isNumberBlocked(senderPhone)) {
      return res.status(200).json({ status: 'blocked' });
    }

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
        slack_thread_ts: null
      });

      if (!conversation) {
        console.error('Failed to create conversation');
        return res.status(500).json({ error: 'Failed to create conversation' });
      }

      isNewConversation = !conversation.slack_thread_ts;
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
      const threadTs = await slack.postNewConversation(conversation, content);
      db.updateConversationThread(threadTs, conversation.id);
    } else {
      const { actualThreadTs } = await slack.postInboundToThread(
        conversation.slack_thread_ts,
        senderPhone,
        recipientPhone,
        content,
        conversation
      );

      if (actualThreadTs && actualThreadTs !== conversation.slack_thread_ts) {
        db.updateConversationThread(actualThreadTs, conversation.id);
      } else {
        db.updateConversationTimestamp(conversation.id);
      }
    }

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
