#!/usr/bin/env bun
/**
 * claude-peers broker daemon
 *
 * A singleton HTTP server backed by SQLite.
 * Tracks all registered Claude Code peers and routes messages between them.
 *
 * Run directly: bun broker.ts
 */

import { Database } from "bun:sqlite";
import { initSchema, createHandlers } from "./broker-handlers.ts";
import type {
  RegisterRequest,
  HeartbeatRequest,
  SetSummaryRequest,
  ListPeersRequest,
  SendMessageRequest,
  PollMessagesRequest,
  Peer,
} from "./shared/types.ts";

const PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const HOST = process.env.CLAUDE_PEERS_HOST ?? "0.0.0.0";
const DB_PATH = process.env.CLAUDE_PEERS_DB ?? `${process.env.HOME}/.claude-peers.db`;
const STALE_TIMEOUT_MS = parseInt(process.env.CLAUDE_PEERS_STALE_TIMEOUT ?? "60000", 10);

// --- Database setup ---

const db = new Database(DB_PATH);
initSchema(db);

const handlers = createHandlers(db, STALE_TIMEOUT_MS);

// Clean on startup + every 30s
handlers.cleanStalePeers();
setInterval(handlers.cleanStalePeers, 30_000);

// --- HTTP Server ---

Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method !== "POST") {
      if (path === "/health") {
        const peers = db.query("SELECT COUNT(*) as count FROM peers").get() as { count: number };
        return Response.json({ status: "ok", peers: peers.count });
      }
      return new Response("claude-peers broker", { status: 200 });
    }

    try {
      const body = await req.json();

      switch (path) {
        case "/register":
          return Response.json(handlers.handleRegister(body as RegisterRequest));
        case "/heartbeat":
          handlers.handleHeartbeat(body as HeartbeatRequest);
          return Response.json({ ok: true });
        case "/set-summary":
          handlers.handleSetSummary(body as SetSummaryRequest);
          return Response.json({ ok: true });
        case "/list-peers":
          return Response.json(handlers.handleListPeers(body as ListPeersRequest));
        case "/send-message":
          return Response.json(handlers.handleSendMessage(body as SendMessageRequest));
        case "/poll-messages":
          return Response.json(handlers.handlePollMessages(body as PollMessagesRequest));
        case "/unregister":
          handlers.handleUnregister(body as { id: string });
          return Response.json({ ok: true });
        default:
          return Response.json({ error: "not found" }, { status: 404 });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return Response.json({ error: msg }, { status: 500 });
    }
  },
});

console.error(`[claude-peers broker] listening on ${HOST}:${PORT} (db: ${DB_PATH})`);
