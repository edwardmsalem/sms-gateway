/**
 * Sweep Test Module
 * Switches all 64 ports to slot 03 simultaneously and tracks message arrivals
 */

const db = require('./database');

const TEST_CHANNEL_ID = 'C07JH0R8754';
const SMS_CHANNEL_ID = process.env.SLACK_CHANNEL_ID;
const SPAM_CHANNEL_ID = 'C0A11NU1JDT';
const VERIFICATION_CHANNEL_ID = 'C05KCUMN35M';

// Active test state
let activeTest = null;

/**
 * Get active test state (for webhook to check)
 */
function getActiveTest() {
  return activeTest;
}

/**
 * Record a message arrival during an active test
 * @param {string} channelType - 'sms', 'spam', or 'verification'
 * @param {string} slot - The slot that received the message
 */
function recordMessageArrival(channelType, slot) {
  if (!activeTest) return;

  const arrival = {
    timestamp: Date.now(),
    channelType,
    slot
  };

  activeTest.arrivals.push(arrival);
  console.log(`[SWEEP TEST] Message recorded: ${channelType} from slot ${slot}`);
}

/**
 * Run the sweep test
 * @param {object} slackApp - Slack Bolt app instance
 * @param {string} bankId - The bank ID (e.g., "50004")
 */
async function runSweepTest(slackApp, bankId) {
  if (activeTest) {
    throw new Error('A sweep test is already in progress');
  }

  const bank = db.getSimBank(bankId);
  if (!bank) {
    throw new Error(`SIM bank ${bankId} not found`);
  }

  // Initialize test state
  activeTest = {
    bankId,
    startTime: null,
    switchCommandTime: null,
    arrivals: [],
    status: 'starting'
  };

  try {
    // Post start message
    await slackApp.client.chat.postMessage({
      channel: TEST_CHANNEL_ID,
      text: `🧪 Starting sweep test - switching all ports to slot 03`
    });

    activeTest.startTime = Date.now();

    // Build switch commands for all 64 ports: 1.03, 2.03, ..., 64.03
    const slots = [];
    for (let port = 1; port <= 64; port++) {
      slots.push(`${port}.03`);
    }

    // Record timestamp when switch commands are sent
    activeTest.switchCommandTime = Date.now();
    activeTest.status = 'switching';

    console.log(`[SWEEP TEST] Sending switch commands for 64 ports to slot 03`);

    // Send all switch commands simultaneously
    const switchUrl = `http://${bank.ip_address}:${bank.port}/goip_send_cmd.html?username=${encodeURIComponent(bank.username)}&password=${encodeURIComponent(bank.password)}`;

    const switchPromises = slots.map(async (slot) => {
      const switchBody = {
        type: 'command',
        op: 'switch',
        ports: slot
      };

      try {
        const res = await fetch(switchUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(switchBody),
          signal: AbortSignal.timeout(10000)
        });

        const text = await res.text();
        return { slot, success: res.ok, response: text };
      } catch (err) {
        return { slot, success: false, error: err.message };
      }
    });

    const switchResults = await Promise.all(switchPromises);
    const successCount = switchResults.filter(r => r.success).length;
    const failCount = switchResults.filter(r => !r.success).length;

    console.log(`[SWEEP TEST] Switch commands sent: ${successCount} success, ${failCount} failed`);

    // Update status
    activeTest.status = 'waiting';
    activeTest.switchResultsSummary = { success: successCount, failed: failCount };

    // Wait 3 minutes (180000 ms)
    const waitTime = 3 * 60 * 1000;
    console.log(`[SWEEP TEST] Waiting ${waitTime / 1000} seconds for messages...`);

    await new Promise(resolve => setTimeout(resolve, waitTime));

    // Calculate results
    activeTest.status = 'complete';
    const endTime = Date.now();

    const totalMessages = activeTest.arrivals.length;
    const smsCount = activeTest.arrivals.filter(a => a.channelType === 'sms').length;
    const spamCount = activeTest.arrivals.filter(a => a.channelType === 'spam').length;
    const verificationCount = activeTest.arrivals.filter(a => a.channelType === 'verification').length;

    // Calculate time from switch command to last message
    let timeToLastMessage = 'N/A';
    if (activeTest.arrivals.length > 0) {
      const lastArrival = activeTest.arrivals.reduce((latest, current) =>
        current.timestamp > latest.timestamp ? current : latest
      );
      const timeDiffMs = lastArrival.timestamp - activeTest.switchCommandTime;
      const timeDiffSec = Math.round(timeDiffMs / 1000);
      const minutes = Math.floor(timeDiffSec / 60);
      const seconds = timeDiffSec % 60;
      timeToLastMessage = `${minutes}m ${seconds}s`;
    }

    // Post results
    const resultsText = `🧪 *Sweep Test Results*

*Total messages received:* ${totalMessages}
*Time from switch to last message:* ${timeToLastMessage}

*Channel breakdown:*
• #sms: ${smsCount}
• #sms-spam: ${spamCount}
• #verification: ${verificationCount}

*Switch commands:* ${successCount}/64 successful`;

    await slackApp.client.chat.postMessage({
      channel: TEST_CHANNEL_ID,
      text: resultsText
    });

    console.log(`[SWEEP TEST] Complete. Results posted.`);

    return {
      totalMessages,
      timeToLastMessage,
      smsCount,
      spamCount,
      verificationCount,
      switchSuccess: successCount,
      switchFailed: failCount
    };

  } finally {
    // Clear active test
    activeTest = null;
  }
}

module.exports = {
  runSweepTest,
  getActiveTest,
  recordMessageArrival,
  TEST_CHANNEL_ID,
  SMS_CHANNEL_ID,
  SPAM_CHANNEL_ID,
  VERIFICATION_CHANNEL_ID
};
