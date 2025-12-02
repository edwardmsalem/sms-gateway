# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

SMS Gateway webhook server for Ejoin SIM banks with Slack integration. Receives SMS from up to 5 SIM banks via HTTP POST, posts to Slack with conversation threading, and enables replies via Slack slash commands.

## Commands

```bash
# Install dependencies
npm install

# Run in development (with auto-reload)
npm run dev

# Run in production
npm start
```

## Architecture

### Data Flow
1. **Inbound SMS**: SIM Bank → POST `/webhook/sms` → Check blocklist → Find/create conversation → Post to Slack
2. **Outbound SMS**: Slack `/reply` command → Lookup conversation → Send via original SIM bank/port → Confirm in thread

### Core Modules
- **src/index.js**: Express server entry point, middleware setup, graceful shutdown
- **src/database.js**: SQLite schema and queries (sql.js - pure JS WebAssembly SQLite)
- **src/webhook.js**: Inbound SMS handler, SIM bank identification, conversation routing
- **src/slack.js**: Slack Bolt app with `/reply`, `/block`, `/unblock`, `/status` commands
- **src/simbank.js**: Ejoin HTTP API wrapper for sending SMS and checking port status
- **src/utils.js**: Phone normalization (E.164), formatting, retry logic

### Database Tables
- `conversations`: Maps sender+recipient to Slack threads, tracks which SIM bank/port received
- `blocked_numbers`: Universal blocklist across all SIM banks
- `messages`: Inbound/outbound message log with status
- `sim_banks`: Configured bank credentials (populated from env vars on startup)

## Ejoin SIM Bank API

### Send SMS
```
GET http://{IP}/goip_send_sms.html?username={user}&password={pass}&port={port}&to={phone}&content={msg}
```
Response codes: 0=success, 1=auth failed, 2=invalid port, 5=SIM not registered

### Get Status
```
GET http://{IP}/goip_get_status.html
```
Port status: 0=No SIM, 1=Idle, 3=Ready, 4=In call, 5=Failed, 6=Low balance

## Key Patterns

- Phone numbers normalized to E.164 format (`+15551234567`) for consistent matching
- Conversations keyed by sender+recipient pair; each pair gets one Slack thread
- SIM bank identified by source IP or `x-simbank-id` header or `?bank_id=` query param
- Slack messages use blocks API for formatting; thread_ts tracks conversation threads
