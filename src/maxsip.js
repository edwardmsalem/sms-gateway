const { google } = require('googleapis');
const crypto = require('crypto');
const db = require('./database');
const slack = require('./slack');
const monday = require('./monday');
const { classifyMessage } = require('./spamFilter');
const { normalizePhone } = require('./utils');

// Gmail API setup
let gmail = null;
let startupTimestamp = null; // Only process emails after this time
const processedMessageIds = new Set(); // Track processed emails to prevent duplicates

// Content-based deduplication (same as webhook.js)
const recentMessages = new Map();
const DEDUPE_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Check if message content is a duplicate (seen within dedupe window)
 */
function isDuplicateMessage(sender, recipient, content) {
  const data = `${sender}|${recipient}|${content}`;
  const key = crypto.createHash('md5').update(data).digest('hex');
  const now = Date.now();

  // Clean up old entries periodically
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
      return true;
    }
  }

  recentMessages.set(key, now);
  return false;
}

/**
 * Initialize Gmail API client
 */
async function initGmail() {
  if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_CLIENT_SECRET || !process.env.GMAIL_REFRESH_TOKEN) {
    console.warn('[MAXSIP] Gmail credentials not configured, skipping initialization');
    return false;
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET
  );

  oauth2Client.setCredentials({
    refresh_token: process.env.GMAIL_REFRESH_TOKEN
  });

  gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  // Record startup time - only process emails received after this
  startupTimestamp = Math.floor(Date.now() / 1000);
  console.log(`[MAXSIP] Gmail API initialized, will only process emails after ${new Date(startupTimestamp * 1000).toISOString()}`);
  return true;
}

/**
 * Parse Maxsip email From address
 * Format: {recipient}-{sender}@maxsipsms.com
 * Example: 15037378356-17708204151@maxsipsms.com
 * Example: 15037378356-61474@maxsipsms.com (short code)
 */
function parseMaxsipFrom(fromAddress) {
  const match = fromAddress.match(/(\d+)-(\d+)@maxsipsms\.com/i);
  if (match) {
    return {
      receiverPhone: match[1],
      senderPhone: match[2]
    };
  }
  return null;
}

/**
 * Check if sender is a short code (5-6 digits)
 */
function isShortCode(phone) {
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 5 && digits.length <= 6;
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
 * Build Slack blocks for Maxsip message with deal enrichment
 */
/**
 * Find the deal that best matches the sender's region
 */
function findBestMatchingDeal(senderAreaCode, deals) {
  if (!deals || deals.length === 0) return null;
  if (deals.length === 1) return deals[0];

  // Try to find a deal that matches the sender's region
  if (senderAreaCode) {
    for (const deal of deals) {
      if (deal.team) {
        const result = monday.doesAreaCodeMatchTeam(senderAreaCode, deal.team);
        if (result.matches) return deal;
      }
    }
  }

  return deals[0];
}

function buildMaxsipBlocks({ content, enrichment }) {
  const { deals, senderStateName, senderPhoneFormatted, receiverPhoneFormatted } = enrichment;

  let text = '';

  if (deals && deals.length > 0) {
    const senderAreaCode = monday.getAreaCodeFromPhone(enrichment.senderPhone);
    const bestDeal = findBestMatchingDeal(senderAreaCode, deals);
    const regionMatch = monday.doesAreaCodeMatchTeam(senderAreaCode, bestDeal.team).matches;
    const matchIndicator = regionMatch ? '✅' : '⚠️';

    // Header: Associate name and receiver phone
    text += `📥 *New SMS to ${bestDeal.associateName}* · ${receiverPhoneFormatted}\n`;

    // From line with state and match indicator
    text += `From: ${senderPhoneFormatted} · ${senderStateName || 'Unknown'} ${matchIndicator}\n`;

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

  return [{
    type: 'section',
    text: { type: 'mrkdwn', text }
  }];
}

/**
 * Process a Maxsip SMS email
 */
async function processMaxsipEmail(message) {
  try {
    // Get full message details
    const fullMessage = await gmail.users.messages.get({
      userId: 'me',
      id: message.id,
      format: 'full'
    });

    // Extract headers
    const headers = fullMessage.data.payload.headers;
    const fromHeader = headers.find(h => h.name.toLowerCase() === 'from')?.value || '';
    const subjectHeader = headers.find(h => h.name.toLowerCase() === 'subject')?.value || '';

    // Check if it's from Maxsip
    if (!fromHeader.includes('@maxsipsms.com')) {
      return;
    }

    // Parse sender/receiver from address
    const parsed = parseMaxsipFrom(fromHeader);
    if (!parsed) {
      console.warn('[MAXSIP] Could not parse From address:', fromHeader);
      return;
    }

    const { receiverPhone, senderPhone } = parsed;

    // Normalize phones
    const normalizedReceiver = normalizePhone(receiverPhone);
    const normalizedSender = normalizePhone(senderPhone);

    // Extract message body
    let content = '';
    const payload = fullMessage.data.payload;
    if (payload.body?.data) {
      content = Buffer.from(payload.body.data, 'base64').toString('utf8');
    } else if (payload.parts) {
      const textPart = payload.parts.find(p => p.mimeType === 'text/plain');
      if (textPart?.body?.data) {
        content = Buffer.from(textPart.body.data, 'base64').toString('utf8');
      }
    }
    content = content.trim();

    if (!content) {
      console.warn('[MAXSIP] Empty message body');
      return;
    }

    console.log(`[MAXSIP] Processing SMS: ${senderPhone} -> ${receiverPhone}`);

    // Check if sender is blocked
    if (db.isNumberBlocked(normalizedSender)) {
      console.log(`[MAXSIP] Blocked sender: ${senderPhone}`);
      return;
    }

    // Check for duplicate messages (same sender+recipient+content within 30 min)
    if (isDuplicateMessage(normalizedSender, normalizedReceiver, content)) {
      console.log(`[MAXSIP] Skipping duplicate message from ${senderPhone} to ${receiverPhone}`);
      return;
    }

    // Check for verification codes FIRST - skip spam filter for these
    const isVerification = slack.isVerificationCode(content);
    if (isVerification) {
      console.log(`[MAXSIP] Verification code detected, skipping spam filter`);
    }

    // Filter short codes as spam (unless verification code)
    if (!isVerification && isShortCode(senderPhone)) {
      console.log(`[MAXSIP] Short code filtered as spam: ${senderPhone}`);
      await slack.postSpamMessage(
        normalizedSender,
        normalizedReceiver,
        content,
        { spam: true, category: 'Short Code', confidence: 'high' },
        'maxsip',
        null
      );
      return;
    }

    // Run spam filter (skip if verification code)
    if (!isVerification) {
      const spamResult = await classifyMessage(content, normalizedSender);
      if (spamResult.spam) {
        console.log(`[MAXSIP] Spam filtered: ${senderPhone}, category=${spamResult.category}`);
        await slack.postSpamMessage(
          normalizedSender,
          normalizedReceiver,
          content,
          spamResult,
          'maxsip',
          null
        );
        return;
      }
    }

    // Look up deals from Monday.com
    let deals = [];
    let senderAreaCode = null;
    let senderState = null;
    let senderStateName = null;
    try {
      deals = await monday.lookupDealsByPhone(normalizedReceiver);
      senderAreaCode = monday.getAreaCodeFromPhone(normalizedSender);
      senderState = monday.getStateFromAreaCode(senderAreaCode);
      senderStateName = monday.STATE_NAMES[senderState] || senderState;
      console.log(`[MAXSIP] Found ${deals.length} deals for ${receiverPhone}`);
    } catch (err) {
      console.warn(`[MAXSIP] Monday lookup failed: ${err.message}`);
    }

    // Build enrichment data
    const enrichment = {
      deals,
      senderPhone: normalizedSender,
      senderAreaCode,
      senderState,
      senderStateName,
      senderPhoneFormatted: formatPhone(senderPhone),
      receiverPhoneFormatted: formatPhone(receiverPhone)
    };

    // Post to Slack
    await slack.postMaxsipMessage(content, enrichment);

    // Mark email as read
    await gmail.users.messages.modify({
      userId: 'me',
      id: message.id,
      requestBody: {
        removeLabelIds: ['UNREAD']
      }
    });

    console.log(`[MAXSIP] Processed and posted to Slack: ${senderPhone} -> ${receiverPhone}`);
  } catch (error) {
    console.error('[MAXSIP] Error processing email:', error.message);
  }
}

/**
 * Poll Gmail for new Maxsip emails
 */
async function pollGmail() {
  if (!gmail || !startupTimestamp) {
    return;
  }

  try {
    // Search for unread emails from Maxsip received AFTER app startup
    const response = await gmail.users.messages.list({
      userId: 'me',
      q: `from:@maxsipsms.com is:unread after:${startupTimestamp}`,
      maxResults: 20
    });

    const messages = response.data.messages || [];

    if (messages.length > 0) {
      console.log(`[MAXSIP] Found ${messages.length} new messages`);
    }

    for (const message of messages) {
      // Skip if already processed (prevents duplicates from race conditions)
      if (processedMessageIds.has(message.id)) {
        console.log(`[MAXSIP] Skipping duplicate message: ${message.id}`);
        continue;
      }

      // Mark as processed BEFORE processing to prevent race condition
      processedMessageIds.add(message.id);

      await processMaxsipEmail(message);

      // Clean up old IDs (keep last 1000 to prevent memory leak)
      if (processedMessageIds.size > 1000) {
        const idsArray = Array.from(processedMessageIds);
        for (let i = 0; i < 500; i++) {
          processedMessageIds.delete(idsArray[i]);
        }
      }
    }
  } catch (error) {
    console.error('[MAXSIP] Gmail poll error:', error.message);
  }
}

/**
 * Start Gmail polling interval
 */
function startPolling(intervalMs = 30000) {
  console.log(`[MAXSIP] Starting Gmail polling every ${intervalMs / 1000}s`);
  setInterval(pollGmail, intervalMs);
  // Run immediately on start
  pollGmail();
}

module.exports = {
  initGmail,
  parseMaxsipFrom,
  isShortCode,
  pollGmail,
  startPolling
};
