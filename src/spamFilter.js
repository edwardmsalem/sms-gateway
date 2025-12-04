const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic();

const SPAM_CLASSIFICATION_PROMPT = `You are an SMS spam classifier for a ticket brokerage business.

DEFAULT: ALLOW messages unless they clearly match a spam category below. When in doubt, allow the message through.

BLOCK these categories (spam):
- Debt collection
- Medicare/health insurance
- Dating/adult content
- Political campaigns
- Investment/crypto scams
- Fashion/retail marketing promos
- Vehicle warranties
- Legal services solicitation
- Sweepstakes/prizes
- Religious/charity solicitation
- Cash App/payment app promos
- Travel deals marketing
- Food delivery promos
- Fitness/gym marketing
- Real estate/mortgage marketing
- Job/work from home offers
- Package delivery scams
- Fake bank alerts
- Tax relief scams
- Home services solicitation (roofing, HVAC, etc.)
- Automated opt-out confirmations ("You've been unsubscribed")

ALWAYS ALLOW:
- Short conversational messages (greetings, "test", "ok", "thanks", etc.)
- Any message that seems like personal communication
- Questions or responses to questions
- Game day notifications
- Event/venue logistics
- Verification codes from any source
- Anything that doesn't clearly match a BLOCK category

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
