require('dotenv').config();

const express = require('express');
const { createServer } = require('http');
const db = require('./database');
const { router: webhookRouter } = require('./webhook');
const { app: slackApp, receiver: slackReceiver } = require('./slack');
const { loadSimBanksFromEnv, formatDateTime } = require('./utils');
const maxsip = require('./maxsip');

const PORT = process.env.PORT || 3000;

async function main() {
  // Initialize database
  await db.initialize();

  // Load SIM bank configurations from environment
  const simBanks = loadSimBanksFromEnv();
  for (const bank of simBanks) {
    db.upsertSimBank(bank);
    console.log(`Configured SIM bank: ${bank.bank_id} at ${bank.ip_address}`);
  }

  if (simBanks.length === 0) {
    console.warn('Warning: No SIM banks configured. Check your .env file.');
  }

  // Create Express app
  const expressApp = express();

  // Trust proxy for accurate IP detection (needed for Railway, etc.)
  expressApp.set('trust proxy', true);

  // Request logging middleware (before everything)
  expressApp.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      console.log(`[${formatDateTime()}] ${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`);
    });
    next();
  });

  // Mount Slack events endpoint FIRST (before body parsers)
  // Bolt needs to read raw body for signature verification
  expressApp.use('/slack/events', slackReceiver.app);

  // Body parsers for all other routes
  expressApp.use(express.json());
  expressApp.use(express.urlencoded({ extended: true }));
  expressApp.use(express.text());
  expressApp.use(express.raw({ type: '*/*' }));

  // Mount webhook routes
  expressApp.use('/webhook', webhookRouter);

  // Root endpoint
  expressApp.get('/', (req, res) => {
    res.json({
      name: 'SMS Gateway',
      version: '1.0.0',
      endpoints: {
        webhook: '/webhook/sms',
        health: '/webhook/health',
        slack: '/slack/events'
      }
    });
  });

  // Start the server
  const server = createServer(expressApp);

  server.listen(PORT, async () => {
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║                    SMS Gateway Server                      ║
╠═══════════════════════════════════════════════════════════╣
║  Server running on port ${PORT.toString().padEnd(33)}║
║  Webhook endpoint: /webhook/sms                           ║
║  Health check: /webhook/health                            ║
║  Slack events: /slack/events                              ║
║                                                           ║
║  SIM Banks configured: ${simBanks.length.toString().padEnd(34)}║
╚═══════════════════════════════════════════════════════════╝
    `);

    // Initialize Maxsip Gmail polling (if configured)
    const gmailInitialized = await maxsip.initGmail();
    if (gmailInitialized) {
      maxsip.startPolling(30000); // Poll every 30 seconds
    }

  });

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('SIGTERM received. Shutting down gracefully...');
    server.close(() => {
      console.log('Server closed.');
      process.exit(0);
    });
  });

  process.on('SIGINT', () => {
    console.log('SIGINT received. Shutting down gracefully...');
    server.close(() => {
      console.log('Server closed.');
      process.exit(0);
    });
  });
}

main().catch(error => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
