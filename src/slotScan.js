/**
 * Slot Scan Module
 * Cycles through all 8 slot positions across all SIM banks
 * Each slot position stays active for 3 minutes before moving to the next
 */

const db = require('./database');

const SCAN_CHANNEL_ID = 'C0642U782JH';
const SLOT_DURATION_MS = 3 * 60 * 1000; // 3 minutes per slot
const TOTAL_SLOTS = 8; // Slots 01 through 08
const PORTS_PER_BANK = 64;
const VERIFICATION_DELAY_MS = 5000; // Wait 5 seconds before verifying

// Port status meanings for better logging
const PORT_STATUS = {
  0: 'No SIM',
  1: 'Idle',
  2: 'Registering',
  3: 'Ready',
  4: 'In call',
  5: 'Reg failed',
  6: 'Low balance',
  7: 'Locked',
  8: 'Locked',
  9: 'SIM error'
};

// Active scan state
let activeScan = null;

/**
 * Get active scan state
 */
function getActiveScan() {
  return activeScan;
}

/**
 * Record a message arrival during scan
 */
function recordMessageArrival(channelType, bankId, slot) {
  if (!activeScan) return;

  activeScan.arrivals.push({
    timestamp: Date.now(),
    channelType,
    bankId,
    slot,
    slotPosition: activeScan.currentSlot
  });
  console.log(`[SLOT SCAN] Message recorded: ${channelType} from bank ${bankId} slot ${slot}`);
}

/**
 * Switch all ports on a bank to a specific slot position
 * @param {object} bank - Bank config
 * @param {number} slotPosition - Slot position (1-8)
 */
async function switchBankToSlot(bank, slotPosition) {
  const slotStr = String(slotPosition).padStart(2, '0');
  const slots = [];

  for (let port = 1; port <= PORTS_PER_BANK; port++) {
    slots.push(`${port}.${slotStr}`);
  }

  const switchUrl = `http://${bank.ip_address}:${bank.port}/goip_send_cmd.html?username=${encodeURIComponent(bank.username)}&password=${encodeURIComponent(bank.password)}`;

  console.log(`[SLOT SCAN] Switching bank ${bank.bank_id} to slot .${slotStr} (${slots.length} ports)`);

  const results = { success: 0, failed: 0, errors: [] };

  // Send switch commands in batches of 16 to avoid overwhelming the bank
  const batchSize = 16;
  for (let i = 0; i < slots.length; i += batchSize) {
    const batch = slots.slice(i, i + batchSize);

    const batchPromises = batch.map(async (slot) => {
      try {
        const res = await fetch(switchUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'command',
            op: 'switch',
            ports: slot
          }),
          signal: AbortSignal.timeout(30000)
        });

        if (res.ok) {
          results.success++;
        } else {
          results.failed++;
          if (results.errors.length < 5) {
            results.errors.push(`${slot}: HTTP ${res.status}`);
          }
        }
      } catch (err) {
        results.failed++;
        if (results.errors.length < 5) {
          let errMsg = err.message;
          if (err.name === 'AbortError') errMsg = 'timeout';
          results.errors.push(`${slot}: ${errMsg}`);
        }
      }
    });

    await Promise.all(batchPromises);

    // Small delay between batches
    if (i + batchSize < slots.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  return results;
}

/**
 * Verify slot activation by checking status API
 * Returns detailed counts including SIM presence
 * @param {object} bank - Bank config
 * @param {number} slotPosition - Expected slot position (1-8)
 */
async function verifySlotActivation(bank, slotPosition) {
  const slotStr = String(slotPosition).padStart(2, '0');

  try {
    const url = `http://${bank.ip_address}:${bank.port}/goip_get_status.html?username=${encodeURIComponent(bank.username)}&password=${encodeURIComponent(bank.password)}&all_slots=1`;

    console.log(`[SLOT SCAN] Verifying bank ${bank.bank_id} at ${bank.ip_address}:${bank.port}`);

    const response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(30000)
    });

    if (!response.ok) {
      const errMsg = `HTTP ${response.status} ${response.statusText}`;
      console.error(`[SLOT SCAN] Bank ${bank.bank_id} verification failed: ${errMsg}`);
      return { error: errMsg, activeCount: 0, totalPorts: 0 };
    }

    let data;
    const rawText = await response.text();
    try {
      data = JSON.parse(rawText);
    } catch (parseErr) {
      console.error(`[SLOT SCAN] Bank ${bank.bank_id} invalid JSON: ${rawText.substring(0, 200)}`);
      return { error: 'Invalid JSON response', activeCount: 0, totalPorts: 0 };
    }

    const statusArray = data.status || data;

    if (!Array.isArray(statusArray)) {
      console.error(`[SLOT SCAN] Bank ${bank.bank_id} unexpected format:`, JSON.stringify(data).substring(0, 200));
      return { error: 'Invalid response format', activeCount: 0, totalPorts: 0 };
    }

    // Detailed slot analysis
    let activeCount = 0;
    let correctSlotCount = 0;
    let withSimCount = 0;
    let emptyCount = 0;
    let readyCount = 0;
    let errorCount = 0;
    const portDetails = [];
    const errorPorts = [];

    for (const slot of statusArray) {
      const port = String(slot.port || '');
      const st = parseInt(slot.st, 10);
      const isActive = slot.active === 1 || slot.active === '1';
      const hasSim = slot.sn && slot.sn !== '' && slot.sn !== 'null';

      // Check if this port's slot matches expected (e.g., "35.04" should have .04 for slot 4)
      const slotSuffix = port.split('.')[1];
      const isCorrectSlot = slotSuffix === slotStr;

      if (isActive) activeCount++;
      if (isActive && isCorrectSlot) correctSlotCount++;

      // SIM presence detection
      if (st === 0 || !hasSim) {
        emptyCount++;
      } else {
        withSimCount++;
        if (st === 3) {
          readyCount++;
        } else if (st === 5 || st === 6 || st === 9) {
          errorCount++;
          if (errorPorts.length < 5) {
            errorPorts.push(`${port}(${PORT_STATUS[st] || 'st=' + st})`);
          }
        }
      }

      // Sample active ports for logging
      if (portDetails.length < 5 && isActive && hasSim) {
        portDetails.push(`${port}(${PORT_STATUS[st] || 'st=' + st})`);
      }
    }

    console.log(`[SLOT SCAN] Bank ${bank.bank_id} slot .${slotStr}: ${correctSlotCount}/${activeCount} active, ${withSimCount} with SIM (${readyCount} ready, ${errorCount} errors), ${emptyCount} empty`);

    return {
      activeCount,
      correctSlotCount,
      totalPorts: statusArray.length,
      withSimCount,
      emptyCount,
      readyCount,
      errorCount,
      samplePorts: portDetails,
      errorPorts
    };
  } catch (err) {
    let errMsg = err.message;
    if (err.name === 'AbortError' || err.message.includes('timeout')) {
      errMsg = 'Connection timeout (30s)';
    } else if (err.code === 'ECONNREFUSED') {
      errMsg = 'Connection refused - device offline?';
    } else if (err.code === 'EHOSTUNREACH') {
      errMsg = 'Host unreachable - network issue?';
    }
    console.error(`[SLOT SCAN] Bank ${bank.bank_id} verification error: ${errMsg}`);
    return { error: errMsg, activeCount: 0, totalPorts: 0 };
  }
}

/**
 * Run the slot scan across all banks
 * @param {object} slackApp - Slack Bolt app instance
 */
async function runSlotScan(slackApp) {
  if (activeScan) {
    throw new Error('A slot scan is already in progress');
  }

  const banks = db.getAllSimBanks();
  if (banks.length === 0) {
    throw new Error('No SIM banks configured');
  }

  // Initialize scan state
  activeScan = {
    startTime: Date.now(),
    banks: banks.map(b => b.bank_id),
    currentSlot: 0,
    arrivals: [],
    slotResults: [],
    status: 'starting'
  };

  try {
    // Post start message
    const startMsg = await slackApp.client.chat.postMessage({
      channel: SCAN_CHANNEL_ID,
      text: `🔄 *Slot Scan Starting*\n\nScanning ${banks.length} bank(s): ${banks.map(b => b.bank_id).join(', ')}\nCycling through slots 01-08, 3 minutes each\nTotal duration: ~24 minutes`
    });

    // Cycle through each slot position
    for (let slotPos = 1; slotPos <= TOTAL_SLOTS; slotPos++) {
      activeScan.currentSlot = slotPos;
      activeScan.status = `slot_${slotPos}`;

      const slotStr = String(slotPos).padStart(2, '0');
      console.log(`[SLOT SCAN] Starting slot ${slotStr}`);

      // Post slot start message
      await slackApp.client.chat.postMessage({
        channel: SCAN_CHANNEL_ID,
        thread_ts: startMsg.ts,
        text: `⏱️ *Slot ${slotStr}* - Switching all ports...`
      });

      // Switch all banks to this slot position
      const switchStart = Date.now();
      const bankResults = [];

      for (const bank of banks) {
        const result = await switchBankToSlot(bank, slotPos);
        bankResults.push({
          bankId: bank.bank_id,
          ...result
        });
        let logMsg = `[SLOT SCAN] Bank ${bank.bank_id} slot ${slotStr}: ${result.success} success, ${result.failed} failed`;
        if (result.errors && result.errors.length > 0) {
          logMsg += ` | Errors: ${result.errors.join(', ')}`;
        }
        console.log(logMsg);
      }

      const switchTime = Math.round((Date.now() - switchStart) / 1000);
      const totalSuccess = bankResults.reduce((sum, r) => sum + r.success, 0);
      const totalFailed = bankResults.reduce((sum, r) => sum + r.failed, 0);

      // Wait a few seconds then verify activation
      await new Promise(r => setTimeout(r, VERIFICATION_DELAY_MS));

      // Verify slots are actually active
      const verificationResults = [];
      let totalActive = 0;
      let totalCorrectSlot = 0;

      for (const bank of banks) {
        const verify = await verifySlotActivation(bank, slotPos);
        verificationResults.push({
          bankId: bank.bank_id,
          ...verify
        });
        if (!verify.error) {
          totalActive += verify.activeCount;
          totalCorrectSlot += verify.correctSlotCount;
        }
        console.log(`[SLOT SCAN] Bank ${bank.bank_id} verification: ${verify.correctSlotCount}/${verify.activeCount} active on slot ${slotStr}${verify.error ? ` (error: ${verify.error})` : ''}`);
      }

      // Build verification status with SIM presence info
      let verifyStatus = '';
      let totalWithSim = 0;
      let totalEmpty = 0;
      let totalReady = 0;
      let totalErrors = 0;

      for (const v of verificationResults) {
        if (v.error) {
          verifyStatus += `\n• Bank ${v.bankId}: :x: ${v.error}`;
        } else {
          totalWithSim += v.withSimCount || 0;
          totalEmpty += v.emptyCount || 0;
          totalReady += v.readyCount || 0;
          totalErrors += v.errorCount || 0;

          const icon = v.readyCount > 0 ? ':white_check_mark:' : (v.withSimCount > 0 ? ':large_yellow_circle:' : ':black_circle:');
          verifyStatus += `\n• Bank ${v.bankId}: ${icon} ${v.withSimCount} SIMs (${v.readyCount} ready`;
          if (v.errorCount > 0) {
            verifyStatus += `, ${v.errorCount} errors`;
          }
          verifyStatus += `), ${v.emptyCount} empty`;
          if (v.errorPorts && v.errorPorts.length > 0) {
            verifyStatus += `\n   :warning: Errors: ${v.errorPorts.join(', ')}`;
          }
        }
      }

      // Summary line
      const summaryLine = `*Summary:* ${totalWithSim} SIMs detected (${totalReady} ready, ${totalErrors} errors), ${totalEmpty} empty slots`;

      // Update with switch + verification results
      await slackApp.client.chat.postMessage({
        channel: SCAN_CHANNEL_ID,
        thread_ts: startMsg.ts,
        text: `*Slot ${slotStr}* switched (${switchTime}s)\nCommands: ${totalSuccess} success, ${totalFailed} failed\n\n*Verification:*${verifyStatus}\n\n${summaryLine}\n\n:hourglass_flowing_sand: Waiting 3 minutes...`
      });

      // Wait for the slot duration
      const waitStart = Date.now();
      const arrivalsAtStart = activeScan.arrivals.length;

      await new Promise(resolve => setTimeout(resolve, SLOT_DURATION_MS));

      // Count arrivals during this slot
      const arrivalsThisSlot = activeScan.arrivals.filter(a => a.slotPosition === slotPos).length;

      activeScan.slotResults.push({
        slot: slotPos,
        switchResults: bankResults,
        arrivals: arrivalsThisSlot
      });

      console.log(`[SLOT SCAN] Slot ${slotStr} complete. ${arrivalsThisSlot} messages received.`);
    }

    // Compile final results
    activeScan.status = 'complete';
    const totalDuration = Math.round((Date.now() - activeScan.startTime) / 1000 / 60);
    const totalArrivals = activeScan.arrivals.length;

    // Build results summary
    let resultsText = `🔄 *Slot Scan Complete*\n\n`;
    resultsText += `*Duration:* ${totalDuration} minutes\n`;
    resultsText += `*Total messages:* ${totalArrivals}\n\n`;
    resultsText += `*Results by slot:*\n`;

    for (const slotResult of activeScan.slotResults) {
      const slotStr = String(slotResult.slot).padStart(2, '0');
      resultsText += `• Slot ${slotStr}: ${slotResult.arrivals} messages\n`;
    }

    // Channel breakdown
    const smsCount = activeScan.arrivals.filter(a => a.channelType === 'sms').length;
    const spamCount = activeScan.arrivals.filter(a => a.channelType === 'spam').length;
    const verificationCount = activeScan.arrivals.filter(a => a.channelType === 'verification').length;

    resultsText += `\n*Channel breakdown:*\n`;
    resultsText += `• #sms: ${smsCount}\n`;
    resultsText += `• #sms-spam: ${spamCount}\n`;
    resultsText += `• #verification: ${verificationCount}`;

    await slackApp.client.chat.postMessage({
      channel: SCAN_CHANNEL_ID,
      thread_ts: startMsg.ts,
      text: resultsText
    });

    console.log(`[SLOT SCAN] Complete. Total ${totalArrivals} messages.`);

    return {
      duration: totalDuration,
      totalArrivals,
      slotResults: activeScan.slotResults
    };

  } finally {
    activeScan = null;
  }
}

/**
 * Stop an active scan
 */
function stopScan() {
  if (activeScan) {
    activeScan.status = 'stopped';
    activeScan = null;
    return true;
  }
  return false;
}

module.exports = {
  runSlotScan,
  getActiveScan,
  recordMessageArrival,
  stopScan,
  SCAN_CHANNEL_ID
};
