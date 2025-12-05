#!/usr/bin/env node
/**
 * One-time script to get Gmail OAuth2 refresh token
 * Run: node scripts/get-gmail-token.js
 */

const { google } = require('googleapis');
const http = require('http');
const url = require('url');

const CLIENT_ID = '1087036364052-4f22qc3p6gbj4d2jshqn3ucet4qs2p20.apps.googleusercontent.com';
const CLIENT_SECRET = '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';
const REDIRECT_URI = 'http://localhost:3333';

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

// Generate auth URL
const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/spreadsheets'
  ]
});

console.log('\n=== Gmail OAuth2 Token Generator ===\n');
console.log('1. Opening browser for authorization...\n');

// Open browser
const open = require('child_process').exec;
const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
open(`${cmd} "${authUrl}"`);

console.log('If browser doesn\'t open, visit this URL:\n');
console.log(authUrl);
console.log('\n2. Waiting for authorization...\n');

// Start local server to catch the callback
const server = http.createServer(async (req, res) => {
  const query = url.parse(req.url, true).query;

  if (query.code) {
    try {
      const { tokens } = await oauth2Client.getToken(query.code);

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h1>Success!</h1><p>You can close this window.</p>');

      console.log('=== SUCCESS ===\n');
      console.log('Add this to your .env file:\n');
      console.log(`TM_GMAIL_CLIENT_ID=${CLIENT_ID}`);
      console.log(`TM_GMAIL_CLIENT_SECRET=${CLIENT_SECRET}`);
      console.log(`TM_GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`);
      console.log('\n');

      server.close();
      process.exit(0);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end(`<h1>Error</h1><p>${err.message}</p>`);
      console.error('Error:', err.message);
      server.close();
      process.exit(1);
    }
  } else if (query.error) {
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end(`<h1>Error</h1><p>${query.error}</p>`);
    console.error('Authorization denied:', query.error);
    server.close();
    process.exit(1);
  }
});

server.listen(3333, () => {
  console.log('Listening on http://localhost:3333 for callback...\n');
});
