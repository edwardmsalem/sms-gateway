const db = require('./database');
const { withRetry } = require('./utils');

// Port status code meanings
const PORT_STATUS = {
  0: 'No SIM card',
  1: 'Idle SIM present',
  2: 'Registering',
  3: 'Registered - Ready',
  4: 'Call connected',
  5: 'Register failed',
  6: 'Low balance',
  7: 'Locked by device',
  8: 'Locked by operator',
  9: 'SIM card error'
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

const SLOT_ACTIVATION_TIMEOUT_MS = 90000;
const SLOT_POLL_INTERVAL_MS = 10000;

// Track last known active slot per bank-channel from inbound SMS
// Key: "bankId-channel" (e.g., "50004-4"), Value: slot (e.g., "4.07")
const lastKnownSlot = new Map();

/**
 * Update the last known slot for a bank-channel
 * Called when inbound SMS arrives
 */
function updateLastKnownSlot(bankId, slot) {
  if (!slot || !slot.includes('.')) return;
  const channel = slot.split('.')[0];
  const key = `${bankId}-${channel}`;
  lastKnownSlot.set(key, slot);
  console.log(`[SLOT TRACKER] Updated ${key} -> ${slot}`);
}

/**
 * Get the last known slot for a bank-channel
 */
function getLastKnownSlot(bankId, channel) {
  const key = `${bankId}-${channel}`;
  return lastKnownSlot.get(key);
}

/**
 * Activate/switch to a specific SIM slot using Ejoin API
 * @param {object} bank - Bank configuration object
 * @param {string} slot - Slot notation (e.g., "4.07")
 */
async function activateSlot(bank, slot) {
  const switchUrl = `http://${bank.ip_address}:${bank.port}/goip_send_cmd.html?username=${encodeURIComponent(bank.username)}&password=${encodeURIComponent(bank.password)}`;

  const switchBody = {
    type: 'command',
    op: 'switch',
    ports: slot
  };

  console.log(`[SLOT ACTIVATE] Switching bank ${bank.bank_id} to slot ${slot}`);
  console.log(`[SLOT ACTIVATE] URL: ${switchUrl}`);
  console.log(`[SLOT ACTIVATE] Body: ${JSON.stringify(switchBody)}`);

  const res = await fetch(switchUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(switchBody),
    signal: AbortSignal.timeout(10000)
  });

  const rawText = await res.text();
  console.log(`[SLOT ACTIVATE] Response: ${rawText}`);

  if (!res.ok) {
    throw new Error(`Slot switch failed: HTTP ${res.status}`);
  }

  // Brief delay for switch to take effect
  await new Promise(resolve => setTimeout(resolve, 2000));
}

/**
 * Check if slot is ready (active === 1 AND st === 3)
 */
function isSlotReady(status) {
  if (status.error) return false;
  const isActive = status.active === 1 || status.active === '1';
  const isRegistered = status.st === 3;
  return isActive && isRegistered;
}

/**
 * Ensure slot is ready, checking status and activating if needed
 * Polls status every 10 seconds until ready or timeout (90s)
 */
async function ensureSlotReady(bank, slot, onProgress) {
  if (!slot || !slot.includes('.')) return;

  onProgress('checking', `Checking status of slot ${slot}...`);

  // Check current status
  let status = await getSlotStatus(bank.bank_id, slot);

  if (status.error) {
    throw new Error(`Failed to get slot status: ${status.error}`);
  }

  // If already ready, send immediately
  if (isSlotReady(status)) {
    onProgress('ready', `Slot ${slot} is ready (active=${status.active}, st=${status.st})`);
    return;
  }

  // Need to activate the slot
  onProgress('switching', `Activating slot ${slot}...`);
  await activateSlot(bank, slot);

  // Poll status until ready or timeout
  const startTime = Date.now();
  const timeoutMs = SLOT_ACTIVATION_TIMEOUT_MS;
  const pollIntervalMs = SLOT_POLL_INTERVAL_MS;

  while (Date.now() - startTime < timeoutMs) {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const remaining = Math.round((timeoutMs - (Date.now() - startTime)) / 1000);

    onProgress('waiting', `Waiting for registration... (${elapsed}s elapsed, ${remaining}s remaining)`);

    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));

    status = await getSlotStatus(bank.bank_id, slot);

    if (status.error) {
      console.warn(`[SLOT POLL] Status check failed: ${status.error}`);
      continue;
    }

    console.log(`[SLOT POLL] ${slot}: active=${status.active}, st=${status.st} (${status.statusText})`);

    if (isSlotReady(status)) {
      onProgress('ready', `Slot ${slot} is ready`);
      return;
    }
  }

  // Timeout reached
  throw new Error(`Slot ${slot} did not become ready within ${timeoutMs / 1000} seconds (last status: ${status.statusText})`);
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

  const url = `http://${bank.ip_address}:${bank.port}/goip_get_status.html?username=${encodeURIComponent(bank.username)}&password=${encodeURIComponent(bank.password)}`;

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
 * Get status of a specific SIM slot
 * @param {string} bankId - The bank ID (e.g., "50004")
 * @param {string} slot - The slot notation (e.g., "4.07")
 * @returns {object} Slot status with all fields or error
 */
async function getSlotStatus(bankId, slot) {
  const bank = db.getSimBank(bankId);
  if (!bank) {
    return { error: `SIM bank ${bankId} not found` };
  }

  const url = `http://${bank.ip_address}:${bank.port}/goip_get_status.html?username=${encodeURIComponent(bank.username)}&password=${encodeURIComponent(bank.password)}&all_slots=1`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      return { error: `HTTP ${response.status}: ${response.statusText}` };
    }

    const data = await response.json();

    // Find the slot in the response - slots are inside data.status array
    let slotData = null;
    const statusArray = data.status || data;
    if (Array.isArray(statusArray)) {
      slotData = statusArray.find(item => String(item.port) === slot);
    }

    if (!slotData) {
      return { error: `Slot ${slot} not found in bank ${bankId}` };
    }

    // Parse status code
    const statusCode = parseInt(slotData.st, 10);
    const statusText = PORT_STATUS[statusCode] || 'Unknown';

    return {
      bankId,
      slot,
      port: slotData.port,
      active: slotData.active,
      st: statusCode,
      statusText,
      sn: slotData.sn || 'N/A',
      sig: slotData.sig,
      bal: slotData.bal || 'N/A',
      opr: slotData.opr || 'N/A',
      iccid: slotData.iccid || null
    };
  } catch (error) {
    return { error: `API call failed: ${error.message}` };
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

/**
 * Find which bank/slot has a specific phone number
 * @param {string} phone - Phone number to search for (will be normalized)
 * @returns {Promise<{bankId: string, slot: string, status: object}|null>}
 */
async function findSlotByPhone(phone) {
  // Normalize phone - strip to digits only
  const searchPhone = phone.replace(/\D/g, '');
  // Also try without leading 1 for US numbers
  const searchPhoneNoCountry = searchPhone.replace(/^1/, '');

  const banks = db.getAllSimBanks();

  for (const bank of banks) {
    try {
      const url = `http://${bank.ip_address}:${bank.port}/goip_get_status.html?username=${encodeURIComponent(bank.username)}&password=${encodeURIComponent(bank.password)}&all_slots=1`;

      const response = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(10000)
      });

      if (!response.ok) continue;

      const data = await response.json();
      const statusArray = data.status || data;

      if (!Array.isArray(statusArray)) continue;

      for (const slotData of statusArray) {
        const slotSn = String(slotData.sn || '').replace(/\D/g, '');
        const slotSnNoCountry = slotSn.replace(/^1/, '');

        if (slotSn === searchPhone || slotSnNoCountry === searchPhoneNoCountry ||
            slotSn === searchPhoneNoCountry || slotSnNoCountry === searchPhone) {
          const statusCode = parseInt(slotData.st, 10);
          return {
            bankId: bank.bank_id,
            slot: String(slotData.port),
            status: {
              active: slotData.active,
              st: statusCode,
              statusText: PORT_STATUS[statusCode] || 'Unknown',
              sn: slotData.sn
            }
          };
        }
      }
    } catch (err) {
      console.error(`[SIMBANK] Error querying bank ${bank.bank_id}:`, err.message);
      continue;
    }
  }

  return null;
}

module.exports = {
  sendSms,
  getStatus,
  getSlotStatus,
  getAllBanksStatus,
  countActiveSims,
  formatStatusForSlack,
  updateLastKnownSlot,
  activateSlot,
  findSlotByPhone,
  PORT_STATUS
};
