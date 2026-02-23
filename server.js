#!/usr/bin/env node
"use strict";

// Polyfill globalThis.crypto for Node 18 (required by Baileys)
if (!globalThis.crypto) {
  const { webcrypto } = require("crypto");
  globalThis.crypto = webcrypto;
}

/**
 * Sena WhatsApp Bridge
 *
 * A standalone Baileys-based WhatsApp Web client that exposes an HTTP API.
 * Designed to be spawned by the Sena backend (whatsapp_bridge_manager.py)
 * or run as a standalone executable.
 *
 * Environment variables:
 *   PORT         — HTTP port (default: 3001)
 *   WEBHOOK_URL  — URL to POST inbound messages to
 *   BRIDGE_URL   — Override the URL the bridge registers as (default: http://localhost:PORT)
 *   API_KEY      — Optional API key for webhook auth
 *   LOG_LEVEL    — Logging level (default: info)
 *   SESSION_DIR  — Directory for session data (default: ./sessions)
 */

const http = require("http");
const path = require("path");
const fs = require("fs");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require("@whiskeysockets/baileys");

// In-memory LID → phone map. Populated from contacts events, persisted to disk.
let lidToPhone = {};
function loadLidMap() {
  try {
    if (fs.existsSync(LID_MAP_PATH)) {
      lidToPhone = JSON.parse(fs.readFileSync(LID_MAP_PATH, 'utf8'));
      console.log(`[bridge] Loaded ${Object.keys(lidToPhone).length} LID mappings from lid_map.json`);
    }
  } catch (e) {
    console.error('[bridge] Failed to load LID map:', e.message);
    lidToPhone = {};
  }
  // Also load individual lid-mapping-*_reverse.json files (LID → phone)
  try {
    const files = fs.readdirSync(SESSION_DIR).filter(f => f.endsWith('_reverse.json') && f.startsWith('lid-mapping-'));
    for (const f of files) {
      try {
        const lid = f.replace('lid-mapping-', '').replace('_reverse.json', '');
        const phone = JSON.parse(fs.readFileSync(path.join(SESSION_DIR, f), 'utf8'));
        if (lid && phone && !lidToPhone[lid]) {
          lidToPhone[lid] = phone;
        }
      } catch (_) {}
    }
    if (Object.keys(lidToPhone).length > 0) {
      console.log(`[bridge] Total LID mappings after loading: ${Object.keys(lidToPhone).length}`);
    }
  } catch (_) {}
}

let _lidSaveTimer = null;
function saveLidMap() {
  if (_lidSaveTimer) clearTimeout(_lidSaveTimer);
  _lidSaveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(LID_MAP_PATH, JSON.stringify(lidToPhone), 'utf8');
      // Also write individual files for compatibility
      for (const [lid, phone] of Object.entries(lidToPhone)) {
        try {
          fs.writeFileSync(path.join(SESSION_DIR, `lid-mapping-${phone}.json`), JSON.stringify(lid), 'utf8');
          fs.writeFileSync(path.join(SESSION_DIR, `lid-mapping-${lid}_reverse.json`), JSON.stringify(phone), 'utf8');
        } catch (_) {}
      }
    } catch (e) {
      console.error('[bridge] Failed to save LID map:', e.message);
    }
  }, 2000);
}

const QRCode = require("qrcode");
const pino = require("pino");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || "3001", 10);
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";
const API_KEY = process.env.API_KEY || "";
const LOG_LEVEL = process.env.LOG_LEVEL || "info";
const SESSION_DIR = process.env.SESSION_DIR || path.join(__dirname, "sessions");
const LID_MAP_PATH = path.join(SESSION_DIR, 'lid_map.json');
loadLidMap();

const logger = pino({ level: LOG_LEVEL === "debug" ? "debug" : "warn" });

// ---------------------------------------------------------------------------
// Message store & retry cache (fixes "Waiting for this message" issue)
// ---------------------------------------------------------------------------

// In-memory message store: maps serialized key -> message content.
// When WhatsApp requests a retry (pre-key re-negotiation), Baileys needs
// the original message content to re-encrypt and resend.
const messageStore = new Map();
const MAX_STORE_SIZE = 5000;

function storeMessage(key, message) {
  const id = `${key.remoteJid}:${key.id}`;
  messageStore.set(id, message);
  if (messageStore.size > MAX_STORE_SIZE) {
    const firstKey = messageStore.keys().next().value;
    messageStore.delete(firstKey);
  }
}

async function getMessage(key) {
  const id = `${key.remoteJid}:${key.id}`;
  return messageStore.get(id) || undefined;
}

// Simple retry counter cache (tracks message retry counts across restarts)
const msgRetryCounterMap = new Map();
const msgRetryCounterCache = {
  get: (key) => msgRetryCounterMap.get(key),
  set: (key, val) => msgRetryCounterMap.set(key, val),
  del: (key) => msgRetryCounterMap.delete(key),
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let sock = null;
let qrDataUrl = "";
let connectionStatus = "disconnected"; // disconnected | qr_ready | connected
let connectedPhone = "";
let lastError = "";

// ---------------------------------------------------------------------------
// Baileys connection
// ---------------------------------------------------------------------------

async function startBaileys() {
  // Ensure session directory exists
  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    browser: ["Sena Agent", "Chrome", "1.0.0"],
    markOnlineOnConnect: false,
    printQRInTerminal: true,
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
    msgRetryCounterCache,
    getMessage,
  });

  // Save credentials on update
  sock.ev.on("creds.update", saveCreds);

  // Build LID → phone map from contacts
  function absorbContacts(contacts) {
    let changed = false;
    for (const c of contacts) {
      if (c.id && c.id.endsWith("@lid") && c.phoneNumber) {
        const lid = c.id.split("@")[0];
        const phone = c.phoneNumber.replace("+", "").replace(/\s|-/g, "");
        if (lidToPhone[lid] !== phone) {
          lidToPhone[lid] = phone;
          changed = true;
        }
      }
    }
    if (changed) saveLidMap();
  }
  sock.ev.on("contacts.set", ({ contacts }) => absorbContacts(contacts));
  sock.ev.on("contacts.update", (updates) => absorbContacts(updates));
  sock.ev.on("contacts.upsert", (contacts) => absorbContacts(contacts));

  // Connection updates
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        qrDataUrl = await QRCode.toDataURL(qr, { width: 256, margin: 2 });
        connectionStatus = "qr_ready";
        console.log("[bridge] QR code generated");
      } catch (err) {
        console.error("[bridge] QR generation failed:", err.message);
      }
    }

    if (connection === "close") {
      const statusCode =
        lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(
        `[bridge] Connection closed. Status: ${statusCode}. Reconnect: ${shouldReconnect}`
      );

      connectionStatus = "disconnected";
      qrDataUrl = "";
      connectedPhone = "";

      if (shouldReconnect) {
        lastError = `Disconnected (code ${statusCode}), reconnecting...`;
        setTimeout(startBaileys, 3000);
      } else {
        lastError = "Logged out. Delete sessions/ folder and restart to re-link.";
        // Clear session data on logout
        try {
          fs.rmSync(SESSION_DIR, { recursive: true, force: true });
          fs.mkdirSync(SESSION_DIR, { recursive: true });
        } catch (_) {}
      }
    }

    if (connection === "open") {
      connectionStatus = "connected";
      qrDataUrl = "";
      lastError = "";
      // Extract phone number from JID
      const me = sock.user;
      connectedPhone = me?.id?.split(":")[0] || me?.id?.split("@")[0] || "";
      console.log(`[bridge] Connected as ${connectedPhone}`);
    }
  });

  // Inbound messages
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    // Store all messages (including outgoing) for retry resolution
    for (const msg of messages) {
      if (msg.message) {
        storeMessage(msg.key, msg.message);
      }
    }

    for (const msg of messages) {
      // Allow self-chat (phone texting itself) through, but skip other outgoing messages
      const remoteJid = msg.key.remoteJid || '';
      const remoteId = remoteJid.split('@')[0] || '';
      const isLidJid = remoteJid.endsWith('@lid');
      // For self-chat: remoteJid may be phone@s.whatsapp.net OR lid@lid
      // Check both: direct phone match, or LID that resolves to connected phone
      const isSelfChat = remoteId === connectedPhone
        || (isLidJid && lidToPhone[remoteId] === connectedPhone);
      if (msg.key.fromMe) {
        if (!isSelfChat) continue;
        console.log(`[bridge] Self-chat message detected (remoteJid=${remoteJid}, connectedPhone=${connectedPhone})`);
      }

      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        "";

      if (!text) continue;

      const from = msg.key.remoteJid || "";
      // Extract raw identifier from JID (may be LID or phone number)
      const rawId = from.split("@")[0];
      const isLid = from.endsWith("@lid");
      // Resolve to actual phone: check lid map, then sock.contacts, then fall back to rawId
      let phone = rawId;
      if (isLid) {
        if (lidToPhone[rawId]) {
          phone = lidToPhone[rawId];
        } else {
          // Try sock.contacts (populated by Baileys from session/sync)
          const contact = sock.contacts && sock.contacts[from];
          const contactPhone = contact?.phoneNumber;
          if (contactPhone) {
            phone = contactPhone.replace("+", "").replace(/\s|-/g, "");
            lidToPhone[rawId] = phone;
            saveLidMap();
            console.log(`[bridge] Resolved LID ${rawId} → ${phone} via sock.contacts`);
          } else {
            // Try individual mapping file on disk
            try {
              const reverseFile = path.join(SESSION_DIR, `lid-mapping-${rawId}_reverse.json`);
              if (fs.existsSync(reverseFile)) {
                const mapped = JSON.parse(fs.readFileSync(reverseFile, 'utf8'));
                if (mapped) {
                  phone = mapped;
                  lidToPhone[rawId] = phone;
                  console.log(`[bridge] Resolved LID ${rawId} → ${phone} via mapping file`);
                }
              }
            } catch (_) {}
          }
        }
      }
      // Chat ID for group or individual
      const chatId = from;
      // Sender JID (for groups this is the participant, for 1:1 it's the remoteJid)
      const fromJid = msg.key.participant || from;
      // Push name
      const fromName = msg.pushName || "";

      console.log(`[bridge] Message from ${phone} (lid=${isLid ? rawId : "n/a"}): ${text.substring(0, 80)}`);

      if (WEBHOOK_URL) {
        sendWebhook({
          from: phone,
          from_lid: isLid ? rawId : "",
          from_jid: fromJid,
          chat_id: chatId,
          from_name: fromName,
          message: text,
          message_id: msg.key.id || "",
        });
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Webhook delivery
// ---------------------------------------------------------------------------

function sendWebhook(payload) {
  const body = JSON.stringify(payload);
  const url = new URL(WEBHOOK_URL);
  const options = {
    hostname: url.hostname,
    port: url.port || (url.protocol === "https:" ? 443 : 80),
    path: url.pathname + url.search,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
  };

  if (API_KEY) {
    options.headers["X-Webhook-Secret"] = API_KEY;
  }

  const proto = url.protocol === "https:" ? require("https") : http;
  const req = proto.request(options, (res) => {
    let data = "";
    res.on("data", (chunk) => (data += chunk));
    res.on("end", () => {
      if (res.statusCode >= 400) {
        console.error(`[bridge] Webhook failed: HTTP ${res.statusCode} ${data.substring(0, 200)}`);
      }
    });
  });
  req.on("error", (err) => {
    console.error(`[bridge] Webhook error: ${err.message}`);
  });
  req.write(body);
  req.end();
}

// ---------------------------------------------------------------------------
// Send message
// ---------------------------------------------------------------------------

async function sendMessage(to, text) {
  if (!sock || connectionStatus !== "connected") {
    return { error: "Not connected to WhatsApp" };
  }

  try {
    const result = await sock.sendMessage(to, { text });
    // Store sent message for retry resolution
    if (result?.key) {
      storeMessage(result.key, result.message);
    }
    return { messageId: result?.key?.id || "" };
  } catch (err) {
    return { error: err.message };
  }
}

async function sendMedia(to, mediaUrl, mediaType, caption) {
  if (!sock || connectionStatus !== "connected") {
    return { error: "Not connected to WhatsApp" };
  }

  try {
    let msgContent;
    if (mediaType === "image") {
      msgContent = { image: { url: mediaUrl }, caption: caption || undefined };
    } else if (mediaType === "video") {
      msgContent = { video: { url: mediaUrl }, caption: caption || undefined };
    } else {
      // document
      const fileName = mediaUrl.split("/").pop() || "document";
      msgContent = {
        document: { url: mediaUrl },
        mimetype: "application/octet-stream",
        fileName,
        caption: caption || undefined,
      };
    }

    const result = await sock.sendMessage(to, msgContent);
    // Store sent message for retry resolution
    if (result?.key) {
      storeMessage(result.key, result.message);
    }
    return { messageId: result?.key?.id || "" };
  } catch (err) {
    return { error: err.message };
  }
}

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendJSON(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Webhook-Secret",
    });
    res.end();
    return;
  }

  const url = req.url?.split("?")[0] || "/";

  // GET /status
  if (url === "/status" && req.method === "GET") {
    sendJSON(res, 200, {
      status: connectionStatus,
      phone: connectedPhone,
      has_qr: connectionStatus === "qr_ready" && qrDataUrl !== "",
      error: lastError,
    });
    return;
  }

  // GET /qr
  if (url === "/qr" && req.method === "GET") {
    if (connectionStatus === "qr_ready" && qrDataUrl) {
      sendJSON(res, 200, { available: true, qr_data_url: qrDataUrl });
    } else {
      sendJSON(res, 200, { available: false, qr_data_url: "" });
    }
    return;
  }

  // POST /send
  if (url === "/send" && req.method === "POST") {
    try {
      const data = await parseBody(req);
      const to = data.to;
      if (!to) {
        sendJSON(res, 400, { error: "Missing 'to' field" });
        return;
      }

      let result;
      if (data.media_url) {
        result = await sendMedia(
          to,
          data.media_url,
          data.media_type || "document",
          data.caption || ""
        );
      } else {
        const text = data.text || data.message || "";
        if (!text) {
          sendJSON(res, 400, { error: "Missing 'text' field" });
          return;
        }
        result = await sendMessage(to, text);
      }

      if (result.error) {
        sendJSON(res, 500, result);
      } else {
        sendJSON(res, 200, result);
      }
    } catch (err) {
      sendJSON(res, 400, { error: err.message });
    }
    return;
  }

  // POST /resolve-numbers — forward-lookup phone numbers to get LID JIDs
  if (url === "/resolve-numbers" && req.method === "POST") {
    try {
      const data = await parseBody(req);
      const phones = data.phones || [];
      if (!Array.isArray(phones) || phones.length === 0) {
        sendJSON(res, 400, { error: "Missing 'phones' array" });
        return;
      }
      if (!sock || connectionStatus !== "connected") {
        sendJSON(res, 503, { error: "Not connected to WhatsApp" });
        return;
      }

      const results = {};
      let newMappings = 0;
      for (const phone of phones) {
        try {
          const jids = await sock.onWhatsApp(phone + "@s.whatsapp.net");
          if (jids && jids.length > 0 && jids[0].exists) {
            const jid = jids[0].jid; // e.g. "181316456869929@lid" or "919841797623@s.whatsapp.net"
            const jidId = jid.split("@")[0];
            const isLid = jid.endsWith("@lid");
            results[phone] = { jid, isLid };
            if (isLid && lidToPhone[jidId] !== phone) {
              lidToPhone[jidId] = phone;
              newMappings++;
            }
          } else {
            results[phone] = { jid: null, isLid: false };
          }
        } catch (err) {
          results[phone] = { error: err.message };
        }
      }
      if (newMappings > 0) {
        saveLidMap();
        console.log(`[bridge] resolve-numbers: ${newMappings} new LID mappings saved`);
      }
      sendJSON(res, 200, { resolved: results, total_mappings: Object.keys(lidToPhone).length });
    } catch (err) {
      sendJSON(res, 400, { error: err.message });
    }
    return;
  }

  // GET /health
  if (url === "/health" && req.method === "GET") {
    sendJSON(res, 200, { ok: true, uptime: process.uptime() });
    return;
  }

  // 404
  sendJSON(res, 404, { error: "Not found" });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

server.listen(PORT, () => {
  console.log(`[bridge] Sena WhatsApp Bridge listening on port ${PORT}`);
  if (WEBHOOK_URL) {
    console.log(`[bridge] Webhook URL: ${WEBHOOK_URL}`);
  }

  // Self-register with backend so it knows our URL
  if (WEBHOOK_URL) {
    const bridgeUrl = process.env.BRIDGE_URL || `http://localhost:${PORT}`;
    const registerUrl = WEBHOOK_URL.replace("receive_webhook", "register_bridge");
    (async () => {
      try {
        const body = JSON.stringify({ bridge_url: bridgeUrl });
        const url = new URL(registerUrl);
        const proto = url.protocol === "https:" ? require("https") : http;
        await new Promise((resolve, reject) => {
          const req = proto.request(
            {
              hostname: url.hostname,
              port: url.port || (url.protocol === "https:" ? 443 : 80),
              path: url.pathname + url.search,
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(body),
              },
            },
            (res) => {
              let data = "";
              res.on("data", (chunk) => (data += chunk));
              res.on("end", () => {
                console.log(`[bridge] Registered with backend: ${data}`);
                resolve();
              });
            }
          );
          req.on("error", reject);
          req.write(body);
          req.end();
        });
      } catch (err) {
        console.error(`[bridge] Failed to register with backend: ${err.message}`);
      }
    })();
  }

  startBaileys().catch((err) => {
    console.error("[bridge] Failed to start Baileys:", err.message);
    lastError = err.message;
  });
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("[bridge] SIGTERM received, shutting down...");
  sock?.end?.();
  server.close(() => process.exit(0));
});

process.on("SIGINT", () => {
  console.log("[bridge] SIGINT received, shutting down...");
  sock?.end?.();
  server.close(() => process.exit(0));
});
