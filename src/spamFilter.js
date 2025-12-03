const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic();

const SPAM_CLASSIFICATION_PROMPT = `You are an SMS spam classifier for a ticket brokerage business. Classify the following message.

BLOCK these categories (spam):
- Debt collection
- Medicare/health insurance
- Dating/adult content
- Political campaigns
- Investment/crypto
- Fashion/retail promos
- Vehicle warranties
- Legal services
- Sweepstakes/prizes
- Religious/charity solicitation
- Cash App/payment app promos
- Travel deals
- Food delivery promos
- Fitness/gym
- Real estate/mortgage
- Job/work from home offers
- Package delivery scams
- Fake bank alerts
- Tax relief
- Home services (roofing, HVAC, etc.)
- Verification codes (EXCEPT from ticket marketplaces or email providers)
- Automated opt-out confirmations ("You've been unsubscribed")

ALLOW these (business-relevant):
- Game day notifications
- Event/venue logistics
- Account check-ins from known contacts
- Renewal reminders
- Verification codes from: StubHub, SeatGeek, Vivid Seats, Ticketmaster, AXS, Tickets.com, Gmail, Yahoo, Outlook, or similar

Respond with JSON only:
{"spam": true/false, "category": "category name or null", "confidence": "high/medium/low"}`;

/**
 * Classify an SMS message as spam or not using Claude
 * @param {string} messageText - The SMS message content
 * @param {string} senderPhone - The sender's phone number
 * @returns {Promise<{spam: boolean, category: string|null, confidence: string}>}
 */
async function classifyMessage(messageText, senderPhone) {
  try {
    const response = await client.messages.create({
      model: 'claude-3-haiku-20240307',
      max_tokens: 100,
      messages: [
        {
          role: 'user',
          content: `${SPAM_CLASSIFICATION_PROMPT}\n\nMessage from ${senderPhone}:\n${messageText}`
        }
      ]
    });

    const responseText = response.content[0].text.trim();

    // Parse JSON response
    const result = JSON.parse(responseText);

    console.log(`[SPAM FILTER] Message from ${senderPhone}: spam=${result.spam}, category=${result.category}, confidence=${result.confidence}`);

    return {
      spam: result.spam === true,
      category: result.category || null,
      confidence: result.confidence || 'low'
    };
  } catch (error) {
    console.error('[SPAM FILTER] Classification failed:', error.message);
    // On error, allow the message through (fail open)
    return {
      spam: false,
      category: null,
      confidence: 'low',
      error: error.message
    };
  }
}

module.exports = {
  classifyMessage
};
