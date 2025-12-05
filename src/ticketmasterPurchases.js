/**
 * Ticketmaster Purchase Email Scraper
 * Monitors forwarded "You Got Tickets To" emails and extracts purchase info to Monday.com
 */

const { google } = require('googleapis');
const db = require('./database');

// Gmail client (lazily initialized)
let gmail = null;
let oauth2Client = null;

// Monday.com API
const MONDAY_API_URL = 'https://api.monday.com/v2';

/**
 * Initialize OAuth2 client
 */
function getOAuth2Client() {
  if (oauth2Client) return oauth2Client;

  if (!process.env.TM_GMAIL_CLIENT_ID || !process.env.TM_GMAIL_CLIENT_SECRET || !process.env.TM_GMAIL_REFRESH_TOKEN) {
    console.log('[TM Purchases] Missing TM_GMAIL_* credentials');
    return null;
  }

  oauth2Client = new google.auth.OAuth2(
    process.env.TM_GMAIL_CLIENT_ID,
    process.env.TM_GMAIL_CLIENT_SECRET
  );

  oauth2Client.setCredentials({
    refresh_token: process.env.TM_GMAIL_REFRESH_TOKEN
  });

  return oauth2Client;
}

/**
 * Initialize Gmail client
 */
function getGmailClient() {
  if (gmail) return gmail;

  const auth = getOAuth2Client();
  if (!auth) return null;

  gmail = google.gmail({ version: 'v1', auth });
  return gmail;
}

/**
 * Monday.com GraphQL query
 */
async function mondayQuery(query, variables = {}) {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    throw new Error('MONDAY_API_TOKEN environment variable is not set');
  }

  const response = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': token,
      'API-Version': '2024-01'
    },
    body: JSON.stringify({ query, variables })
  });

  if (!response.ok) {
    throw new Error(`Monday.com API returned HTTP ${response.status}`);
  }

  const data = await response.json();
  if (data.errors) {
    const errorMsg = data.errors[0]?.message || JSON.stringify(data.errors);
    throw new Error('Monday.com query failed: ' + errorMsg);
  }
  return data.data;
}

/**
 * Create an item in Monday.com board
 */
async function createMondayItem(boardId, itemName, columnValues) {
  const query = `
    mutation ($boardId: ID!, $itemName: String!, $columnValues: JSON!) {
      create_item(board_id: $boardId, item_name: $itemName, column_values: $columnValues) {
        id
      }
    }
  `;

  const result = await mondayQuery(query, {
    boardId: boardId,
    itemName: itemName,
    columnValues: JSON.stringify(columnValues)
  });

  return result.create_item?.id;
}

/**
 * Check if email ID has been processed
 */
function isEmailProcessed(emailId) {
  const result = db.getOne(
    'SELECT 1 FROM processed_tm_emails WHERE email_id = ?',
    [emailId]
  );
  return !!result;
}

/**
 * Mark email ID as processed
 */
function markEmailProcessed(emailId) {
  db.run(
    'INSERT OR IGNORE INTO processed_tm_emails (email_id) VALUES (?)',
    [emailId]
  );
}

/**
 * Decode base64 email content
 */
function decodeBase64(data) {
  if (!data) return '';
  // Gmail uses URL-safe base64
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64').toString('utf-8');
}

/**
 * Get email body from message parts
 */
function getEmailBody(payload) {
  if (!payload) return '';

  // Simple message with body data
  if (payload.body && payload.body.data) {
    return decodeBase64(payload.body.data);
  }

  // Multipart message - look for text/plain or text/html
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body && part.body.data) {
        return decodeBase64(part.body.data);
      }
    }
    // Fallback to HTML
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body && part.body.data) {
        return decodeBase64(part.body.data);
      }
    }
    // Recursively check nested parts
    for (const part of payload.parts) {
      if (part.parts) {
        const body = getEmailBody(part);
        if (body) return body;
      }
    }
  }

  return '';
}

/**
 * Parse purchase details from email body
 */
function parsePurchaseDetails(body, subject) {
  const details = {
    event: '',
    venue: '',
    cityState: '',
    eventDate: '',
    eventTime: '',
    section: '',
    row: '',
    lowSeat: '',
    highSeat: '',
    quantity: '',
    orderNumber: '',
    totalPrice: '',
    tmAccount: ''
  };

  // Extract event name from subject (after "FW: You Got Tickets To ")
  const eventMatch = subject.match(/FW:\s*You Got Tickets To\s+(.+)/i);
  if (eventMatch) {
    details.event = eventMatch[1].trim();
  }

  // Extract TM Account - the original "To:" address in the forwarded email
  const toMatch = body.match(/(?:^|\n)\s*To:\s*<?([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})>?/im);
  if (toMatch) {
    details.tmAccount = toMatch[1].toLowerCase();
  }

  // Extract Order Number (e.g., "Order # 55-14260/CAR")
  const orderMatch = body.match(/Order\s*#\s*([A-Z0-9\-\/]+)/i);
  if (orderMatch) {
    details.orderNumber = orderMatch[1];
  }

  // Extract date/time (e.g., "Tue · Apr 14, 2026 · 7:30 PM" or similar)
  const dateTimeMatch = body.match(/(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s*[·•]\s*([A-Z][a-z]{2}\s+\d{1,2},?\s+\d{4})\s*[·•]\s*(\d{1,2}:\d{2}\s*(?:AM|PM))/i);
  if (dateTimeMatch) {
    details.eventDate = dateTimeMatch[1];
    details.eventTime = dateTimeMatch[2];
  }

  // Extract venue and location
  // Look for "Venue Name — City, ST" or "Venue Name - City, ST" pattern
  const venueMatch = body.match(/([A-Za-z0-9\s&'.()-]+(?:Arena|Center|Coliseum|Stadium|Theatre|Theater|Hall|Garden|Pavilion|Amphitheatre|Amphitheater|Field|Park|Dome))\s*[—–-]\s*([A-Za-z\s]+),\s*([A-Z]{2})/i);
  if (venueMatch) {
    details.venue = venueMatch[1].trim();
    details.cityState = `${venueMatch[2].trim()}, ${venueMatch[3]}`;
  } else {
    // Try to find venue name alone
    const altVenueMatch = body.match(/First Horizon Coliseum|Madison Square Garden|[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:Arena|Center|Coliseum|Stadium|Theatre|Theater|Hall|Garden|Pavilion)/);
    if (altVenueMatch) {
      details.venue = altVenueMatch[0];
    }
    // Look for US city, STATE pattern (2-letter state code required)
    const cityStateMatch = body.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*),\s*([A-Z]{2})(?:\s|<|$|\n)/);
    if (cityStateMatch) {
      details.cityState = `${cityStateMatch[1]}, ${cityStateMatch[2]}`;
    }
  }

  // Extract section, row, seats (e.g., "Sec 233, Row Z, Seat 9 - 12")
  const seatMatch = body.match(/Sec(?:tion)?\s*(\w+),?\s*Row\s*(\w+),?\s*Seat\s*(\d+)\s*[-–]\s*(\d+)/i);
  if (seatMatch) {
    details.section = seatMatch[1];
    details.row = seatMatch[2];
    details.lowSeat = seatMatch[3];
    details.highSeat = seatMatch[4];
    details.quantity = (parseInt(seatMatch[4]) - parseInt(seatMatch[3]) + 1).toString();
  } else {
    const singleSeatMatch = body.match(/Sec(?:tion)?\s*(\w+),?\s*Row\s*(\w+),?\s*Seat\s*(\d+)(?:\s|<|$)/i);
    if (singleSeatMatch) {
      details.section = singleSeatMatch[1];
      details.row = singleSeatMatch[2];
      details.lowSeat = singleSeatMatch[3];
      details.highSeat = singleSeatMatch[3];
      details.quantity = '1';
    }
  }

  // Extract total price (e.g., "Total: $222.80")
  const priceMatch = body.match(/Total:\s*\$?([\d,]+\.?\d*)/i);
  if (priceMatch) {
    details.totalPrice = '$' + priceMatch[1];
  }

  return details;
}

/**
 * Get email header value
 */
function getHeader(headers, name) {
  const header = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
  return header ? header.value : '';
}

/**
 * Scan for Ticketmaster purchase emails and process them
 * @param {Date} sinceDate - Only process emails after this date
 * @returns {Object} - { processed: number, errors: number }
 */
async function scanPurchaseEmails(sinceDate = null) {
  const gmailClient = getGmailClient();
  if (!gmailClient) {
    console.log('[TM Purchases] Gmail client not available');
    return { processed: 0, errors: 0, skipped: 0 };
  }

  const boardId = process.env.TM_PURCHASES_BOARD_ID;
  if (!boardId) {
    console.log('[TM Purchases] TM_PURCHASES_BOARD_ID not set');
    return { processed: 0, errors: 0, skipped: 0 };
  }

  // Build search query
  let query = 'subject:"FW: You Got Tickets To"';

  if (sinceDate) {
    const dateStr = sinceDate.toISOString().split('T')[0].replace(/-/g, '/');
    query += ` after:${dateStr}`;
  }

  console.log(`[TM Purchases] Searching: ${query}`);

  let processed = 0;
  let errors = 0;
  let skipped = 0;
  let pageToken = null;

  try {
    do {
      const listResponse = await gmailClient.users.messages.list({
        userId: 'me',
        q: query,
        maxResults: 50,
        pageToken: pageToken
      });

      const messages = listResponse.data.messages || [];
      console.log(`[TM Purchases] Found ${messages.length} emails in this batch`);

      for (const msg of messages) {
        try {
          if (isEmailProcessed(msg.id)) {
            skipped++;
            continue;
          }

          const fullMsg = await gmailClient.users.messages.get({
            userId: 'me',
            id: msg.id,
            format: 'full'
          });

          const headers = fullMsg.data.payload.headers;
          const subject = getHeader(headers, 'Subject');
          const date = getHeader(headers, 'Date');
          const body = getEmailBody(fullMsg.data.payload);

          const details = parsePurchaseDetails(body, subject);

          // Build Monday.com column values (column IDs from board)
          const columnValues = {
            'email_mkybwtx9': details.tmAccount ? { email: details.tmAccount, text: details.tmAccount } : null, // TM Account
            'text_mkyb65e9': details.venue,              // Venue
            'text_mkybdyt9': details.cityState,          // City/State
            'date4': details.eventDate ? { date: formatMondayDate(details.eventDate) } : null, // Event Date
            'text_mkybzdft': details.eventTime,          // Event Time
            'text_mkybpe84': details.section,            // Section
            'text_mkybsxmr': details.row,                // Row
            'numeric_mkyb5sqp': details.lowSeat,         // Low Seat
            'numeric_mkyb4cs': details.highSeat,         // High Seat
            'numeric_mkybzsxh': details.quantity,        // Quantity
            'text_mkybck6m': details.orderNumber,        // Order #
            'text_mkybv5ey': details.totalPrice          // Total Price
          };

          // Remove null values
          Object.keys(columnValues).forEach(key => {
            if (columnValues[key] === null || columnValues[key] === '') {
              delete columnValues[key];
            }
          });

          // Create item with event name as the item name
          const itemId = await createMondayItem(boardId, details.event || 'Unknown Event', columnValues);

          if (itemId) {
            markEmailProcessed(msg.id);
            processed++;
            console.log(`[TM Purchases] Created: ${details.event} - ${details.orderNumber}`);
          } else {
            errors++;
          }

        } catch (error) {
          console.error(`[TM Purchases] Error processing email ${msg.id}:`, error.message);
          errors++;
        }
      }

      pageToken = listResponse.data.nextPageToken;
    } while (pageToken);

  } catch (error) {
    console.error('[TM Purchases] Error scanning emails:', error.message);
    errors++;
  }

  console.log(`[TM Purchases] Complete: ${processed} processed, ${skipped} skipped, ${errors} errors`);
  return { processed, errors, skipped };
}

/**
 * Format date string to Monday.com format (YYYY-MM-DD)
 */
function formatMondayDate(dateStr) {
  try {
    // Parse "Apr 14, 2026" format
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return null;
    return date.toISOString().split('T')[0];
  } catch (e) {
    return null;
  }
}

/**
 * Run initial scan for all emails since Dec 1, 2025
 */
async function runInitialScan() {
  console.log('[TM Purchases] Running initial scan since Dec 1, 2025...');
  const sinceDate = new Date('2025-12-01');
  return await scanPurchaseEmails(sinceDate);
}

/**
 * Run hourly scan (last 2 hours to catch any missed)
 */
async function runHourlyScan() {
  console.log('[TM Purchases] Running hourly scan...');
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  return await scanPurchaseEmails(twoHoursAgo);
}

/**
 * Clear all processed email records to allow rescan
 */
function clearProcessedEmails() {
  db.run('DELETE FROM processed_tm_emails');
  console.log('[TM Purchases] Cleared processed emails - will rescan all');
}

/**
 * Start the hourly scheduler
 */
let schedulerInterval = null;

function startScheduler(intervalMs = 60 * 60 * 1000) {
  if (schedulerInterval) {
    console.log('[TM Purchases] Scheduler already running');
    return;
  }

  console.log(`[TM Purchases] Starting scheduler (interval: ${intervalMs / 1000 / 60} minutes)`);

  // Check if rescan requested via env var
  if (process.env.RESCAN_TM_PURCHASES === 'true') {
    clearProcessedEmails();
  }

  // Run initial scan immediately
  runInitialScan().catch(err => console.error('[TM Purchases] Initial scan error:', err));

  // Schedule hourly scans
  schedulerInterval = setInterval(() => {
    runHourlyScan().catch(err => console.error('[TM Purchases] Hourly scan error:', err));
  }, intervalMs);
}

function stopScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    console.log('[TM Purchases] Scheduler stopped');
  }
}

module.exports = {
  scanPurchaseEmails,
  runInitialScan,
  runHourlyScan,
  startScheduler,
  stopScheduler
};
