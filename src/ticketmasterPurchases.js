/**
 * Ticketmaster Purchase Email Scraper
 * Monitors forwarded "You Got Tickets To" emails and extracts purchase info to Google Sheets
 */

const { google } = require('googleapis');
const db = require('./database');

// Clients (lazily initialized)
let gmail = null;
let sheets = null;
let oauth2Client = null;

// Sheet ID from environment
const SHEET_ID = process.env.TM_PURCHASES_SHEET_ID || '1qf3bofd-96JN27wPN75ZcaEuLgRWwh-SPfHxa4HzRtk';

// Sheet columns (will auto-create header row if empty)
const COLUMNS = [
  'Date Processed',
  'Email Date',
  'TM Account',
  'Event',
  'Venue',
  'City/State',
  'Event Date',
  'Event Time',
  'Section',
  'Row',
  'Low Seat',
  'High Seat',
  'Quantity',
  'Order #',
  'Total Price',
  'Email ID'
];

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
 * Initialize Sheets client
 */
function getSheetsClient() {
  if (sheets) return sheets;

  const auth = getOAuth2Client();
  if (!auth) return null;

  sheets = google.sheets({ version: 'v4', auth });
  return sheets;
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
 * Ensure the sheet has headers
 */
async function ensureSheetHeaders() {
  const sheetsClient = getSheetsClient();
  if (!sheetsClient) return false;

  try {
    // Check if first row has data
    const response = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'A1:P1'
    });

    const values = response.data.values;
    if (!values || values.length === 0 || !values[0] || values[0].length === 0) {
      // Add headers
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: 'A1',
        valueInputOption: 'RAW',
        requestBody: {
          values: [COLUMNS]
        }
      });
      console.log('[TM Purchases] Created header row in sheet');
    }

    return true;
  } catch (error) {
    console.error('[TM Purchases] Error ensuring headers:', error.message);
    return false;
  }
}

/**
 * Append a row to the sheet
 */
async function appendToSheet(rowData) {
  const sheetsClient = getSheetsClient();
  if (!sheetsClient) return false;

  try {
    await sheetsClient.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'A:P',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [rowData]
      }
    });
    return true;
  } catch (error) {
    console.error('[TM Purchases] Error appending to sheet:', error.message);
    return false;
  }
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
  // Look for patterns like "To: email@example.com" or "To:" followed by email
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
  // Handle both plain text and HTML entities
  const dateTimeMatch = body.match(/(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s*[·•]\s*([A-Z][a-z]{2}\s+\d{1,2},?\s+\d{4})\s*[·•]\s*(\d{1,2}:\d{2}\s*(?:AM|PM))/i);
  if (dateTimeMatch) {
    details.eventDate = dateTimeMatch[1];
    details.eventTime = dateTimeMatch[2];
  }

  // Extract venue and location
  // Look for venue pattern - usually after location icon or in specific format
  // Pattern: "Venue Name — City, State" or "Venue Name - City, State"
  const venueMatch = body.match(/(?:\n|>)\s*([A-Za-z0-9\s&'.()-]+(?:Arena|Center|Coliseum|Stadium|Theatre|Theater|Hall|Garden|Pavilion|Amphitheatre|Amphitheater|Field|Park|Dome))\s*[—–-]\s*([^<\n]+)/i);
  if (venueMatch) {
    details.venue = venueMatch[1].trim();
    details.cityState = venueMatch[2].trim();
  } else {
    // Try alternate pattern
    const altVenueMatch = body.match(/First Horizon Coliseum|Madison Square Garden|[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:Arena|Center|Coliseum|Stadium|Theatre|Theater|Hall|Garden|Pavilion)/);
    if (altVenueMatch) {
      details.venue = altVenueMatch[0];
    }
    // Look for city, state pattern
    const cityStateMatch = body.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*),\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*|[A-Z]{2})\s*(?:<|$|\n)/);
    if (cityStateMatch) {
      details.cityState = `${cityStateMatch[1]}, ${cityStateMatch[2]}`;
    }
  }

  // Extract section, row, seats (e.g., "Sec 233, Row Z, Seat 9 - 12")
  // Handle various formats: "Sec 233", "Section 233", etc.
  const seatMatch = body.match(/Sec(?:tion)?\s*(\w+),?\s*Row\s*(\w+),?\s*Seat\s*(\d+)\s*[-–]\s*(\d+)/i);
  if (seatMatch) {
    details.section = seatMatch[1];
    details.row = seatMatch[2];
    details.lowSeat = seatMatch[3];
    details.highSeat = seatMatch[4];
    details.quantity = (parseInt(seatMatch[4]) - parseInt(seatMatch[3]) + 1).toString();
  } else {
    // Try single seat or GA
    const singleSeatMatch = body.match(/Sec(?:tion)?\s*(\w+),?\s*Row\s*(\w+),?\s*Seat\s*(\d+)(?:\s|<|$)/i);
    if (singleSeatMatch) {
      details.section = singleSeatMatch[1];
      details.row = singleSeatMatch[2];
      details.lowSeat = singleSeatMatch[3];
      details.highSeat = singleSeatMatch[3];
      details.quantity = '1';
    }
  }

  // Extract total price (e.g., "Total: $222.80" or "Total:  $222.80")
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

  // Ensure sheet has headers
  await ensureSheetHeaders();

  // Build search query
  // Subject starts with "FW: You Got Tickets To"
  let query = 'subject:"FW: You Got Tickets To"';

  if (sinceDate) {
    // Format date as YYYY/MM/DD for Gmail
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
      // Search for emails
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
          // Skip if already processed
          if (isEmailProcessed(msg.id)) {
            skipped++;
            continue;
          }

          // Get full message
          const fullMsg = await gmailClient.users.messages.get({
            userId: 'me',
            id: msg.id,
            format: 'full'
          });

          const headers = fullMsg.data.payload.headers;
          const subject = getHeader(headers, 'Subject');
          const date = getHeader(headers, 'Date');
          const body = getEmailBody(fullMsg.data.payload);

          // Parse purchase details
          const details = parsePurchaseDetails(body, subject);

          // Build row data
          const rowData = [
            new Date().toISOString(),           // Date Processed
            date,                                // Email Date
            details.tmAccount,                   // TM Account
            details.event,                       // Event
            details.venue,                       // Venue
            details.cityState,                   // City/State
            details.eventDate,                   // Event Date
            details.eventTime,                   // Event Time
            details.section,                     // Section
            details.row,                         // Row
            details.lowSeat,                     // Low Seat
            details.highSeat,                    // High Seat
            details.quantity,                    // Quantity
            details.orderNumber,                 // Order #
            details.totalPrice,                  // Total Price
            msg.id                               // Email ID
          ];

          // Append to sheet
          const success = await appendToSheet(rowData);
          if (success) {
            markEmailProcessed(msg.id);
            processed++;
            console.log(`[TM Purchases] Processed: ${details.event} - ${details.orderNumber}`);
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
 * Start the hourly scheduler
 */
let schedulerInterval = null;

function startScheduler(intervalMs = 60 * 60 * 1000) { // Default: 1 hour
  if (schedulerInterval) {
    console.log('[TM Purchases] Scheduler already running');
    return;
  }

  console.log(`[TM Purchases] Starting scheduler (interval: ${intervalMs / 1000 / 60} minutes)`);

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
  stopScheduler,
  ensureSheetHeaders
};
