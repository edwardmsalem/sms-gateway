#!/usr/bin/env node
/**
 * Quick script to inspect messages in the verification channel
 * to understand the format of forwarded emails
 */

const { WebClient } = require('@slack/web-api');

const token = process.env.SLACK_BOT_TOKEN;
if (!token) {
  console.error('SLACK_BOT_TOKEN environment variable not set');
  process.exit(1);
}

const client = new WebClient(token);
const CHANNEL_ID = 'C05KCUMN35M';

async function main() {
  try {
    // Get recent messages from the channel
    const result = await client.conversations.history({
      channel: CHANNEL_ID,
      limit: 10
    });

    console.log(`Found ${result.messages.length} messages\n`);
    console.log('='.repeat(80));

    for (const msg of result.messages) {
      console.log('\n--- MESSAGE ---');
      console.log('Type:', msg.type);
      console.log('Subtype:', msg.subtype || 'none');
      console.log('User:', msg.user || msg.bot_id || 'unknown');
      console.log('Timestamp:', new Date(msg.ts * 1000).toISOString());

      if (msg.text) {
        console.log('\nText:');
        console.log(msg.text.substring(0, 500));
      }

      if (msg.attachments) {
        console.log('\nAttachments:', JSON.stringify(msg.attachments, null, 2).substring(0, 1000));
      }

      if (msg.blocks) {
        console.log('\nBlocks:', JSON.stringify(msg.blocks, null, 2).substring(0, 1000));
      }

      if (msg.files) {
        console.log('\nFiles:', msg.files.length);
      }

      console.log('\n' + '='.repeat(80));
    }

  } catch (error) {
    console.error('Error:', error.message);
    if (error.data) {
      console.error('Details:', error.data);
    }
  }
}

main();
