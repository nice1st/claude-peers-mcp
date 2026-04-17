#!/usr/bin/env bun
/**
 * claude-peers broker daemon
 *
 * A singleton HTTP server backed by in-memory Map (no SQLite).
 * Tracks all registered Claude Code peers and routes messages between them via SSE.
 *
 * Run directly: bun broker.ts
 */

import { createHandlers, peers, encoder, logPeerRemoved } from "./broker-handlers.ts";
import type {
  RegisterRequest,
  SetSummaryRequest,
  ListPeersRequest,
  SendMessageRequest,
} from "./shared/types.ts";

const PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const HOST = process.env.CLAUDE_PEERS_HOST ?? "0.0.0.0";

const handlers = createHandlers();

// 30초마다 모든 SSE 연결에 keepalive 전송. write 실패 시 peer 제거.
setInterval(() => {
  for (const [id, entry] of peers) {
    try {
      entry.controller.enqueue(encoder.encode(": keepalive\n\n"));
    } catch {
      peers.delete(id);
      logPeerRemoved(id, "keepalive-failed");
    }
  }
}, 30_000);

// --- HTTP Server ---

Bun.serve({
  port: PORT,
  hostname: HOST,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // GET /health
    if (req.method === "GET") {
      if (path === "/health") {
        return Response.json({ status: "ok", peers: peers.size });
      }
      return new Response("claude-peers broker", { status: 200 });
    }

    if (req.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }

    try {
      // POST /register → SSE 스트림 응답
      if (path === "/register") {
        const body = await req.json() as RegisterRequest;

        let streamController: ReadableStreamDefaultController;
        const stream = new ReadableStream({
          start(controller) {
            streamController = controller;
            handlers.handleRegister(body, controller);
          },
          cancel() {
            // 재등록으로 이미 교체된 경우 삭제하지 않음
            const current = peers.get(body.id);
            if (current?.controller === streamController) {
              peers.delete(body.id);
              logPeerRemoved(body.id, "sse-cancelled");
            }
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
          },
        });
      }

      const body = await req.json();

      switch (path) {
        case "/set-summary":
          handlers.handleSetSummary(body as SetSummaryRequest);
          return Response.json({ ok: true });
        case "/list-peers":
          return Response.json(handlers.handleListPeers(body as ListPeersRequest));
        case "/send-message":
          return Response.json(handlers.handleSendMessage(body as SendMessageRequest));
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

console.error(`[claude-peers broker] listening on ${HOST}:${PORT}`);
