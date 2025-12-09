/**
 * Slot Scan Module
 * Cycles through all 8 slot positions across all SIM banks
 * Each slot position stays active for 3 minutes before moving to the next
 */

const db = require('./database');

const TEST_CHANNEL_ID = 'C07JH0R8754';
const SLOT_DURATION_MS = 3 * 60 * 1000; // 3 minutes per slot
const TOTAL_SLOTS = 8; // Slots 01 through 08
const PORTS_PER_BANK = 64;
const VERIFICATION_DELAY_MS = 5000; // Wait 5 seconds before verifying

// Active scan state
let activeScan = null;

// Port status meanings (from simbank.js)
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

  const results = { success: 0, failed: 0 };

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
        }
      } catch (err) {
        results.failed++;
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
 * Returns count of ports with expected slot active
 * @param {object} bank - Bank config
 * @param {number} slotPosition - Expected slot position (1-8)
 */
async function verifySlotActivation(bank, slotPosition) {
  const slotStr = String(slotPosition).padStart(2, '0');

  try {
    const url = `http://${bank.ip_address}:${bank.port}/goip_get_status.html?username=${encodeURIComponent(bank.username)}&password=${encodeURIComponent(bank.password)}&all_slots=1`;

    const response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(30000)
    });

    if (!response.ok) {
      return { error: `HTTP ${response.status}`, activeCount: 0, totalPorts: 0, simPresent: 0, noSim: 0, emptySlots: [] };
    }

    const data = await response.json();
    const statusArray = data.status || data;

    if (!Array.isArray(statusArray)) {
      return { error: 'Invalid response format', activeCount: 0, totalPorts: 0, simPresent: 0, noSim: 0, emptySlots: [] };
    }

    // Count ports where active=1 and slot matches expected position
    let activeCount = 0;
    let correctSlotCount = 0;
    let simPresent = 0;
    let noSim = 0;
    let registered = 0;
    const portDetails = [];
    const emptySlots = []; // Track which slots have no SIM (by ICCID)

    for (const slot of statusArray) {
      const port = String(slot.port || '');
      const isActive = slot.active === 1 || slot.active === '1';
      const st = parseInt(slot.st, 10);
      const iccid = slot.iccid || '';

      // Check if this port's slot matches expected (e.g., "35.04" should have .04 for slot 4)
      const slotSuffix = port.split('.')[1];
      const isCorrectSlot = slotSuffix === slotStr;

      if (isActive) activeCount++;
      if (isActive && isCorrectSlot) correctSlotCount++;

      // Count SIM presence - use ICCID as primary indicator (more reliable than st===0)
      const hasSimCard = iccid && iccid.length > 0;
      if (hasSimCard) {
        simPresent++;
        if (st === 3) registered++;
      } else {
        noSim++;
        // Extract port number for empty slot tracking
        const portNum = port.split('.')[0];
        if (portNum) emptySlots.push(portNum);
      }

      // Sample some ports for logging
      if (portDetails.length < 5 && isActive) {
        portDetails.push(`${port}(st=${st},iccid=${iccid ? 'yes' : 'no'})`);
      }
    }

    return {
      activeCount,
      correctSlotCount,
      totalPorts: statusArray.length,
      samplePorts: portDetails,
      simPresent,
      noSim,
      registered,
      emptySlots
    };
  } catch (err) {
    return { error: err.message, activeCount: 0, totalPorts: 0, simPresent: 0, noSim: 0, emptySlots: [] };
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
      channel: TEST_CHANNEL_ID,
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
        channel: TEST_CHANNEL_ID,
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
        console.log(`[SLOT SCAN] Bank ${bank.bank_id} slot ${slotStr}: ${result.success} success, ${result.failed} failed`);
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

      // Build verification status
      let verifyStatus = '';
      let totalSimPresent = 0;
      let totalNoSim = 0;
      let totalRegistered = 0;
      const allEmptySlots = {};

      for (const v of verificationResults) {
        if (v.error) {
          verifyStatus += `\n• Bank ${v.bankId}: ⚠️ ${v.error}`;
        } else {
          const icon = v.correctSlotCount > 0 ? '✅' : '⚠️';
          verifyStatus += `\n• Bank ${v.bankId}: ${icon} ${v.correctSlotCount} ports on .${slotStr}, ${v.activeCount} total active`;
          verifyStatus += `\n  📶 SIMs (by ICCID): ${v.simPresent} present (${v.registered} registered), ${v.noSim} empty`;
          if (v.emptySlots && v.emptySlots.length > 0) {
            // Show which ports have no SIM
            const emptyList = v.emptySlots.length <= 10
              ? v.emptySlots.join(', ')
              : `${v.emptySlots.slice(0, 10).join(', ')}... +${v.emptySlots.length - 10} more`;
            verifyStatus += `\n  ❌ Empty ports: ${emptyList}`;
            allEmptySlots[v.bankId] = v.emptySlots;
          }
          if (v.samplePorts.length > 0) {
            verifyStatus += `\n  Sample: ${v.samplePorts.join(', ')}`;
          }
          totalSimPresent += v.simPresent;
          totalNoSim += v.noSim;
          totalRegistered += v.registered;
        }
      }

      // Store SIM stats for final summary (only on first slot - counts don't change)
      if (!activeScan.simStats) {
        activeScan.simStats = { simPresent: totalSimPresent, noSim: totalNoSim, registered: totalRegistered, emptySlots: allEmptySlots };
      }

      // Update with switch + verification results
      await slackApp.client.chat.postMessage({
        channel: TEST_CHANNEL_ID,
        thread_ts: startMsg.ts,
        text: `✅ *Slot ${slotStr}* switched (${switchTime}s)\nCommands: ${totalSuccess} success, ${totalFailed} failed\n\n*Verification:*${verifyStatus}\n\n⏳ Waiting 3 minutes...`
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

    // Build per-port message tally
    const portMessageCounts = new Map();
    for (const arrival of activeScan.arrivals) {
      // Extract port number from slot (e.g., "4.07" -> "4")
      const portNum = arrival.slot ? arrival.slot.split('.')[0] : 'unknown';
      const key = `${arrival.bankId}-${portNum}`;
      portMessageCounts.set(key, (portMessageCounts.get(key) || 0) + 1);
    }

    // Build results summary
    let resultsText = `🔄 *Slot Scan Complete*\n\n`;
    resultsText += `*Duration:* ${totalDuration} minutes\n`;
    resultsText += `*Total messages:* ${totalArrivals}\n`;

    // Include SIM stats
    if (activeScan.simStats) {
      const { simPresent, noSim, registered, emptySlots } = activeScan.simStats;
      resultsText += `\n*SIM Card Status (by ICCID):*\n`;
      resultsText += `• 📶 SIMs present: ${simPresent} (${registered} registered/ready)\n`;
      resultsText += `• ❌ Empty slots: ${noSim}\n`;

      // List empty ports per bank
      if (emptySlots && Object.keys(emptySlots).length > 0) {
        for (const [bankId, ports] of Object.entries(emptySlots)) {
          if (ports.length > 0) {
            const portList = ports.length <= 15
              ? ports.join(', ')
              : `${ports.slice(0, 15).join(', ')}... +${ports.length - 15} more`;
            resultsText += `  Bank ${bankId} empty: ${portList}\n`;
          }
        }
      }
    }

    resultsText += `\n*Results by slot position:*\n`;

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
      channel: TEST_CHANNEL_ID,
      text: resultsText
    });

    // Post per-port breakdown per bank
    for (const bank of banks) {
      const bankPorts = [];
      for (let port = 1; port <= PORTS_PER_BANK; port++) {
        const key = `${bank.bank_id}-${port}`;
        const count = portMessageCounts.get(key) || 0;
        bankPorts.push({ port, count });
      }

      // Find ports with 0 messages (potentially odd)
      const zeroPorts = bankPorts.filter(p => p.count === 0).map(p => p.port);
      const activePorts = bankPorts.filter(p => p.count > 0);

      let portText = `📊 *Bank ${bank.bank_id} - Per-Port Message Tally*\n\n`;

      if (activePorts.length > 0) {
        portText += `*Ports with messages:*\n`;
        // Group by count for cleaner display
        const countGroups = new Map();
        for (const p of activePorts) {
          const ports = countGroups.get(p.count) || [];
          ports.push(p.port);
          countGroups.set(p.count, ports);
        }

        // Sort by count descending
        const sortedCounts = [...countGroups.entries()].sort((a, b) => b[0] - a[0]);
        for (const [count, ports] of sortedCounts) {
          portText += `• ${count} msg${count > 1 ? 's' : ''}: ports ${ports.join(', ')}\n`;
        }
      } else {
        portText += `⚠️ *No messages received from any port*\n`;
      }

      if (zeroPorts.length > 0) {
        portText += `\n⚠️ *Ports with 0 messages (${zeroPorts.length}):*\n`;
        // Show first 20 to avoid spam
        if (zeroPorts.length <= 20) {
          portText += `${zeroPorts.join(', ')}\n`;
        } else {
          portText += `${zeroPorts.slice(0, 20).join(', ')}... and ${zeroPorts.length - 20} more\n`;
        }
        portText += `_These may be empty slots or inactive SIMs_`;
      }

      await slackApp.client.chat.postMessage({
        channel: TEST_CHANNEL_ID,
        text: portText
      });
    }

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
  TEST_CHANNEL_ID
};
