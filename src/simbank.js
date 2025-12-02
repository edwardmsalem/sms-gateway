const db = require('./database');
const { withRetry } = require('./utils');

// Port status code meanings
const PORT_STATUS = {
  0: 'No SIM card',
  1: 'Idle',
  2: 'Registering',
  3: 'Registered (ready)',
  4: 'Call connected',
  5: 'Register failed',
  6: 'Low balance',
  7: 'Locked by device',
  8: 'Locked by operator'
};

// Ejoin API error codes
const SMS_ERROR_CODES = {
  0: 'OK',
  1: 'Invalid User',
  2: 'Invalid Port',
  3: 'USSD Expected',
  4: 'Pending USSD',
  5: 'SIM Unregistered',
  6: 'Timeout',
  7: 'Server Error',
  8: 'SMS expected',
  9: 'TO expected (recipients missed)',
  10: 'Pending Transaction',
  11: 'TID Expected',
  12: 'FROM Expected',
  13: 'Duplicated TaskId',
  14: 'Unauthorized',
  15: 'Invalid CMD',
  16: 'Too Many Task'
};

const SLOT_ACTIVATION_WAIT_MS = 60000;
const PROGRESS_INTERVAL_MS = 10000;

/**
 * Get status of a specific slot
 * @returns {number|null} Status code (3 = ready) or null if unknown
 */
async function getSlotStatus(bank, slot) {
  const url = `http://${bank.ip_address}:${bank.port}/goip_get_status.html`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(5000)
    });

    if (!response.ok) return null;

    const data = await response.json();

    // Look for the slot in the response - format could be {"4.07": 3} or {"4": 3}
    if (typeof data === 'object' && !Array.isArray(data)) {
      if (data[slot] !== undefined) {
        return parseInt(data[slot], 10);
      }
      const portNum = slot.split('.')[0];
      if (data[portNum] !== undefined) {
        return parseInt(data[portNum], 10);
      }
    }

    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Switch to a specific SIM slot before sending
 */
async function switchToSlot(bank, slot) {
  const switchUrl = `http://${bank.ip_address}:${bank.port}/goip_send_cmd.html?username=${encodeURIComponent(bank.username)}&password=${encodeURIComponent(bank.password)}`;

  const switchBody = {
    type: 'command',
    op: 'switch',
    ports: slot
  };

  const res = await fetch(switchUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(switchBody),
    signal: AbortSignal.timeout(10000)
  });

  const rawText = await res.text();

  let response;
  try {
    response = JSON.parse(rawText);
  } catch (e) {
    // Non-JSON response, continue anyway
    return;
  }

  if (response.code !== 0 && response.code !== 200) {
    console.warn(`Slot switch warning - code ${response.code}: ${response.reason || 'unknown'}`);
  }

  // Brief delay for switch to take effect
  await new Promise(resolve => setTimeout(resolve, 1000));
}

/**
 * Wait for slot activation with progress updates
 */
async function waitForSlotActivation(slot, onProgress) {
  const totalWaitMs = SLOT_ACTIVATION_WAIT_MS;
  const intervalMs = PROGRESS_INTERVAL_MS;
  const iterations = Math.floor(totalWaitMs / intervalMs);

  for (let i = iterations; i > 0; i--) {
    await new Promise(resolve => setTimeout(resolve, intervalMs));
    const remainingSeconds = (i - 1) * (intervalMs / 1000);
    if (remainingSeconds > 0) {
      onProgress('waiting', `${remainingSeconds}s remaining...`);
    }
  }
}

/**
 * Ensure slot is ready, switching and waiting if needed
 */
async function ensureSlotReady(bank, slot, onProgress) {
  if (!slot || !slot.includes('.')) return;

  onProgress('checking', `Checking if slot ${slot} is active...`);
  const status = await getSlotStatus(bank, slot);

  if (status === 3) {
    onProgress('ready', `Slot ${slot} is ready`);
    return;
  }

  // Need to switch and wait
  onProgress('switching', `Activating slot ${slot}...`);
  await switchToSlot(bank, slot);

  onProgress('waiting', `Waiting 60s for slot ${slot} to register...`);
  await waitForSlotActivation(slot, onProgress);
  onProgress('ready', `Slot ${slot} activation complete`);
}

/**
 * Strip phone to digits only (Ejoin expects no + prefix)
 */
function cleanPhoneForApi(phone) {
  return phone.replace(/^\+/, '');
}

/**
 * Extract port number from slot notation (e.g., "4.07" -> "4")
 */
function getPortFromSlot(slot) {
  if (slot && slot.includes('.')) {
    return slot.split('.')[0];
  }
  return slot;
}

/**
 * Send SMS through a SIM bank
 * @param {string} bankId - The bank ID (e.g., "50004")
 * @param {string} slot - The slot notation (e.g., "4.07")
 * @param {string} toPhone - Destination phone number
 * @param {string} message - Message content
 * @param {function} onProgress - Optional callback: (step, message) => void
 */
async function sendSms(bankId, slot, toPhone, message, onProgress) {
  const progress = onProgress || (() => {});

  if (!toPhone) {
    throw new Error('toPhone is required');
  }

  const bank = db.getSimBank(bankId);
  if (!bank) {
    throw new Error(`SIM bank ${bankId} not found`);
  }

  // Ensure slot is ready
  await ensureSlotReady(bank, slot, progress);

  // Build API request
  const portNumber = getPortFromSlot(slot);
  const channel = parseInt(portNumber, 10);
  const cleanPhone = cleanPhoneForApi(toPhone);
  const postUrl = `http://${bank.ip_address}:${bank.port}/goip_post_sms.html?username=${encodeURIComponent(bank.username)}&password=${encodeURIComponent(bank.password)}`;
  const tid = Date.now();

  const postBody = {
    type: 'send-sms',
    task_num: 1,
    tasks: [{
      tid,
      from: channel,
      to: cleanPhone,
      sms: message
    }]
  };

  console.log(`[OUTBOUND SMS] bankId=${bankId} slot=${slot} channel=${channel} to=${toPhone} tid=${tid}`);
  console.log(`[OUTBOUND SMS] message preview: ${message.substring(0, 50)}${message.length > 50 ? '...' : ''}`);
  console.log(`[OUTBOUND SMS] request body:`, JSON.stringify(postBody));
  progress('sending', `Sending SMS from slot ${slot}...`);

  const response = await withRetry(async () => {
    const res = await fetch(postUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(postBody),
      signal: AbortSignal.timeout(10000)
    });

    const rawText = await res.text();

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }

    let jsonResponse;
    try {
      jsonResponse = JSON.parse(rawText);
    } catch (parseErr) {
      throw new Error(`Invalid JSON response: ${rawText}`);
    }

    return jsonResponse;
  }, { maxRetries: 2, baseDelay: 1000 });

  console.log(`[OUTBOUND SMS] response:`, JSON.stringify(response));

  // Check response - validate both code and task status
  if (response.code !== 200) {
    const errorMessage = SMS_ERROR_CODES[response.code] || response.reason || 'Unknown error';
    throw new Error(`${errorMessage} (code: ${response.code})`);
  }

  // Also check individual task status
  const taskStatus = response.status?.[0]?.status;
  if (taskStatus && !taskStatus.startsWith('0')) {
    throw new Error(`Task failed with status: ${taskStatus}`);
  }

  return { ...response, tid };
}

/**
 * Get status of all ports on a SIM bank
 */
async function getStatus(bankId) {
  const bank = db.getSimBank(bankId);
  if (!bank) {
    throw new Error(`SIM bank ${bankId} not found`);
  }

  const url = `http://${bank.ip_address}:${bank.port}/goip_get_status.html`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(5000)
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    return {
      bankId,
      online: true,
      ports: parsePortStatus(data)
    };
  } catch (error) {
    return {
      bankId,
      online: false,
      error: error.message,
      ports: []
    };
  }
}

/**
 * Parse port status response from SIM bank
 */
function parsePortStatus(data) {
  const ports = [];

  if (Array.isArray(data)) {
    data.forEach((status, index) => {
      ports.push({
        port: indexToPort(index),
        status: status,
        statusText: PORT_STATUS[status] || 'Unknown'
      });
    });
  } else if (typeof data === 'object') {
    for (const [port, status] of Object.entries(data)) {
      ports.push({
        port,
        status: parseInt(status, 10),
        statusText: PORT_STATUS[status] || 'Unknown'
      });
    }
  }

  return ports;
}

/**
 * Convert array index to port name (0 -> "1A", 1 -> "1B", etc.)
 */
function indexToPort(index) {
  const row = Math.floor(index / 2) + 1;
  const col = index % 2 === 0 ? 'A' : 'B';
  return `${row}${col}`;
}

/**
 * Get status of all configured SIM banks
 */
async function getAllBanksStatus() {
  const banks = db.getAllSimBanks();
  return Promise.all(banks.map(bank => getStatus(bank.bank_id)));
}

/**
 * Count active (ready) SIMs across all banks
 */
async function countActiveSims() {
  const statuses = await getAllBanksStatus();
  let total = 0;
  let ready = 0;

  for (const bank of statuses) {
    if (bank.ports) {
      for (const port of bank.ports) {
        total++;
        if (port.status === 3) ready++;
      }
    }
  }

  return { total, ready };
}

/**
 * Format bank status for Slack display
 */
function formatStatusForSlack(status) {
  if (!status.online) {
    return `*Bank ${status.bankId}*: :red_circle: Offline - ${status.error}`;
  }

  const readyCount = status.ports.filter(p => p.status === 3).length;
  const totalCount = status.ports.length;

  const portDetails = status.ports
    .map(p => {
      const emoji = p.status === 3 ? ':white_check_mark:' : ':x:';
      return `${p.port}: ${emoji} ${p.statusText}`;
    })
    .join('\n');

  return `*Bank ${status.bankId}*: :green_circle: Online - ${readyCount}/${totalCount} SIMs ready\n${portDetails}`;
}

module.exports = {
  sendSms,
  getStatus,
  getAllBanksStatus,
  countActiveSims,
  formatStatusForSlack,
  PORT_STATUS
};
