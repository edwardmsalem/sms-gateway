const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic();

const SPAM_CLASSIFICATION_PROMPT = `You are an SMS spam classifier for a ticket brokerage business.

DEFAULT: ALLOW messages unless they clearly match a spam category below. When in doubt, allow the message through.

BLOCK these categories (spam):
- Non-English messages (Spanish, Chinese, etc. - any language other than English)
- Wigs/Hair marketing (wig, lace front, bundles, UNice, hair sale)
- Fashion/Retail spam (Fashion Nova, SHEIN, Temu, DHgate, "50% off your order")
- Weight loss spam (weight loss, keto, ozempic, diet pill)
- CBD/Cannabis (CBD, gummies, THC, dispensary)
- Porn/Adult/Dating (singles in your area, dating, hookup, adult content)
- Crypto/NFT spam (bitcoin, crypto, NFT, ethereum, blockchain)
- Amazon employee alerts (Amazon A to Z, AtoZ, "your shift has been")
- Weather alerts (tornado warning, flash flood warning, Weather Alert)
- Debt collection (debt collector, "attempt to collect", past due account)
- Loan spam (pre-approved for, credit limit increase, personal loan offers)
- Medicare/Insurance (medicare, open enrollment, health coverage, ACA plan)
- Shipping/Delivery notifications (your package, delivery attempt, out for delivery, has shipped, tracking number, SPEEDX, GOFO Express, UPS, FedEx, USPS, DHL)
- Pharmacy/prescription notifications (Rx ready, refill reminders, Kroger pharmacy, CVS, Walgreens)
- Appointment reminders (doctor, dentist, therapy, telehealth, salon appointments)
- Healthcare/therapy marketing (clinics soliciting clients, wellness services, mental health outreach, booking links)
- Political campaigns
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
- Fake bank alerts
- Tax relief scams
- Home services solicitation (roofing, HVAC, plumbing, etc.)
- Automated opt-out confirmations ("You've been unsubscribed", "Reply STOP")

ALWAYS ALLOW (never block these):
- Short conversational messages (greetings, "test", "ok", "thanks", etc.)
- Any message that seems like personal communication between humans
- Questions or responses to questions
- Game day notifications related to tickets/events
- Event/venue logistics
- Verification codes from any source (these are CRITICAL - never block)
- Ticket-related messages (seats, tickets, section, row, transfer)
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
