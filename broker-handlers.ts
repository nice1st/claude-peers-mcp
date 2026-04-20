/**
 * Broker handler logic — separated for testability.
 * Peers are tracked in memory (no SQLite). SSE controllers are stored per peer.
 */

import type {
  RegisterRequest,
  RegisterResponse,
  SetSummaryRequest,
  ListPeersRequest,
  SendMessageRequest,
  Peer,
} from "./shared/types.ts";

export const encoder = new TextEncoder();

function encode(s: string): Uint8Array {
  return encoder.encode(s);
}

export function logPeerRemoved(id: string, reason: string): void {
  console.error(`[claude-peers broker] peer removed: id=${id} reason=${reason}`);
}

interface PeerEntry {
  id: string;
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  registered_at: string;
  controller: ReadableStreamDefaultController;
}

// 모듈 레벨 메모리 map — 테스트에서 peers.clear()로 초기화
export const peers = new Map<string, PeerEntry>();

export function createHandlers() {
  function handleRegister(
    body: RegisterRequest,
    controller: ReadableStreamDefaultController,
  ): RegisterResponse {
    const id = body.id;
    const now = new Date().toISOString();

    // 같은 id 재등록 시 이전 SSE 닫기 (좀비 방지)
    const existing = peers.get(id);
    if (existing) {
      try { existing.controller.close(); } catch { /* already closed */ }
      peers.delete(id);
      logPeerRemoved(id, "re-registered");
    }

    const entry: PeerEntry = {
      id,
      pid: body.pid,
      cwd: body.cwd,
      git_root: body.git_root,
      tty: body.tty,
      summary: body.summary,
      registered_at: now,
      controller,
    };
    peers.set(id, entry);

    // 첫 SSE 이벤트: 등록 완료
    controller.enqueue(encode(`data: ${JSON.stringify({ type: "registered", id })}\n\n`));

    return { id };
  }

  function handleSetSummary(body: SetSummaryRequest): void {
    const entry = peers.get(body.id);
    if (entry) {
      entry.summary = body.summary;
    }
  }

  function handleListPeers(body: ListPeersRequest): Peer[] {
    let entries = [...peers.values()];

    switch (body.scope) {
      case "directory":
        entries = entries.filter((e) => e.cwd === body.cwd);
        break;
      case "repo":
        if (body.git_root) {
          entries = entries.filter((e) => e.git_root === body.git_root);
        } else {
          entries = entries.filter((e) => e.cwd === body.cwd);
        }
        break;
      case "machine":
      default:
        // 전체 반환
        break;
    }

    if (body.exclude_id) {
      entries = entries.filter((e) => e.id !== body.exclude_id);
    }

    return entries.map(({ controller: _c, ...peer }) => peer);
  }

  function handleSendMessage(body: SendMessageRequest): { ok: boolean; error?: string } {
    const entry = peers.get(body.to_id);
    if (!entry) {
      return { ok: false, error: `Peer ${body.to_id} not found` };
    }

    const event: Record<string, unknown> = {
      type: "message",
      from_id: body.from_id,
      text: body.text,
      sent_at: new Date().toISOString(),
    };
    if (body.skill) event.skill = body.skill;

    try {
      entry.controller.enqueue(encode(`data: ${JSON.stringify(event)}\n\n`));
    } catch {
      peers.delete(body.to_id);
      logPeerRemoved(body.to_id, "send-failed");
      return { ok: false, error: `Peer ${body.to_id} SSE connection closed` };
    }

    return { ok: true };
  }

  function handleUnregister(body: { id: string }): void {
    const entry = peers.get(body.id);
    if (entry) {
      try { entry.controller.close(); } catch { /* already closed */ }
      peers.delete(body.id);
      logPeerRemoved(body.id, "unregistered");
    }
  }

  return {
    handleRegister,
    handleSetSummary,
    handleListPeers,
    handleSendMessage,
    handleUnregister,
  };
}
