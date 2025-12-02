const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

let db = null;
const dbPath = path.resolve(process.env.DATABASE_PATH || './data/sms.db');

async function initialize() {
  const SQL = await initSqlJs();

  // Load existing database if it exists
  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  // Create tables
  db.run(`
    CREATE TABLE IF NOT EXISTS sim_banks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bank_id TEXT UNIQUE NOT NULL,
      ip_address TEXT NOT NULL,
      port INTEGER NOT NULL DEFAULT 80,
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_phone TEXT NOT NULL,
      recipient_phone TEXT NOT NULL,
      sim_bank_id TEXT NOT NULL,
      sim_port TEXT NOT NULL,
      slack_channel_id TEXT NOT NULL,
      slack_thread_ts TEXT,
      last_message_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(sender_phone, recipient_phone)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS blocked_numbers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_number TEXT UNIQUE NOT NULL,
      blocked_by TEXT,
      reason TEXT,
      blocked_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
      content TEXT NOT NULL,
      sent_by_slack_user TEXT,
      status TEXT DEFAULT 'sent',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_conversations_sender ON conversations(sender_phone)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_conversations_recipient ON conversations(recipient_phone)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_blocked_numbers_phone ON blocked_numbers(phone_number)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id)`);

  save();
  console.log('Database initialized');
}

function save() {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(dbPath, buffer);
}

function getOne(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function getAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

function run(sql, params = []) {
  db.run(sql, params);
  save();
  return { lastInsertRowid: db.exec("SELECT last_insert_rowid()")[0]?.values[0]?.[0] };
}

// SIM Banks
function upsertSimBank(data) {
  const existing = getSimBank(data.bank_id);
  if (existing) {
    run(
      `UPDATE sim_banks SET ip_address = ?, port = ?, username = ?, password = ? WHERE bank_id = ?`,
      [data.ip_address, data.port, data.username, data.password, data.bank_id]
    );
  } else {
    run(
      `INSERT INTO sim_banks (bank_id, ip_address, port, username, password, is_active) VALUES (?, ?, ?, ?, ?, 1)`,
      [data.bank_id, data.ip_address, data.port, data.username, data.password]
    );
  }
}

function getSimBank(bankId) {
  return getOne('SELECT * FROM sim_banks WHERE bank_id = ?', [bankId]);
}

function getAllSimBanks() {
  return getAll('SELECT * FROM sim_banks WHERE is_active = 1');
}

// Conversations
function findConversation(sender, recipient) {
  return getOne('SELECT * FROM conversations WHERE sender_phone = ? AND recipient_phone = ?', [sender, recipient]);
}

function findConversationBySender(sender) {
  return getOne('SELECT * FROM conversations WHERE sender_phone = ? ORDER BY last_message_at DESC LIMIT 1', [sender]);
}

function findConversationByThreadTs(threadTs) {
  return getOne('SELECT * FROM conversations WHERE slack_thread_ts = ?', [threadTs]);
}

function getRecentConversations(channelId) {
  return getAll(
    'SELECT * FROM conversations WHERE slack_channel_id = ? ORDER BY last_message_at DESC LIMIT 10',
    [channelId]
  );
}

function createConversation(data) {
  // Use INSERT OR IGNORE to handle duplicate sender+recipient gracefully
  run(
    `INSERT OR IGNORE INTO conversations (sender_phone, recipient_phone, sim_bank_id, sim_port, slack_channel_id, slack_thread_ts)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [data.sender_phone, data.recipient_phone, data.sim_bank_id, data.sim_port, data.slack_channel_id, data.slack_thread_ts]
  );
  // Always return the conversation by looking up sender+recipient (handles both new and existing)
  return getOne('SELECT * FROM conversations WHERE sender_phone = ? AND recipient_phone = ?',
    [data.sender_phone, data.recipient_phone]);
}

function updateConversationThread(threadTs, id) {
  run(`UPDATE conversations SET slack_thread_ts = ?, last_message_at = datetime('now') WHERE id = ?`, [threadTs, id]);
}

function updateConversationTimestamp(id) {
  run(`UPDATE conversations SET last_message_at = datetime('now') WHERE id = ?`, [id]);
}

function getConversationById(id) {
  return getOne('SELECT * FROM conversations WHERE id = ?', [id]);
}

// Blocked Numbers
function isNumberBlocked(phone) {
  return !!getOne('SELECT 1 FROM blocked_numbers WHERE phone_number = ?', [phone]);
}

function blockNumber(phone, blockedBy, reason) {
  const existing = getOne('SELECT 1 FROM blocked_numbers WHERE phone_number = ?', [phone]);
  if (existing) {
    run('UPDATE blocked_numbers SET blocked_by = ?, reason = ?, blocked_at = datetime("now") WHERE phone_number = ?',
      [blockedBy, reason, phone]);
  } else {
    run('INSERT INTO blocked_numbers (phone_number, blocked_by, reason) VALUES (?, ?, ?)',
      [phone, blockedBy, reason]);
  }
}

function unblockNumber(phone) {
  run('DELETE FROM blocked_numbers WHERE phone_number = ?', [phone]);
}

function getBlockedNumbers() {
  return getAll('SELECT * FROM blocked_numbers ORDER BY blocked_at DESC');
}

// Messages
function insertMessage(data) {
  return run(
    `INSERT INTO messages (conversation_id, direction, content, sent_by_slack_user, status)
     VALUES (?, ?, ?, ?, ?)`,
    [data.conversation_id, data.direction, data.content, data.sent_by_slack_user, data.status]
  );
}

function getMessagesByConversation(convId, limit = 50) {
  return getAll('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?', [convId, limit]);
}

// Stats
function getStats() {
  const messagesResult = getOne('SELECT COUNT(*) as count FROM messages WHERE created_at > datetime("now", "-24 hours")');
  const conversationsResult = getOne('SELECT COUNT(*) as count FROM conversations');
  const blockedResult = getOne('SELECT COUNT(*) as count FROM blocked_numbers');

  return {
    messagesLast24h: messagesResult?.count || 0,
    totalConversations: conversationsResult?.count || 0,
    blockedNumbers: blockedResult?.count || 0
  };
}

module.exports = {
  initialize,
  save,

  // SIM Banks
  upsertSimBank,
  getSimBank,
  getAllSimBanks,

  // Conversations
  findConversation,
  findConversationBySender,
  findConversationByThreadTs,
  getRecentConversations,
  createConversation,
  updateConversationThread,
  updateConversationTimestamp,
  getConversationById,

  // Blocked Numbers
  isNumberBlocked,
  blockNumber,
  unblockNumber,
  getBlockedNumbers,

  // Messages
  insertMessage,
  getMessagesByConversation,

  // Stats
  getStats
};
