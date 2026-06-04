/**
 * Broker handler logic — separated for testability.
 * Peers are tracked in memory (no SQLite). SSE controllers are stored per peer.
 *
 * peer_id 형식: `machine:alias` (예: "yhchoi-mac:analyst").
 * - machine, alias, group은 normalize()로 정규화 (`:` 제거 포함).
 * - peer_id는 정규화된 machine과 alias를 `:`로 결합한 결과 (`:` 보존).
 */

import type {
  RegisterRequest,
  RegisterResponse,
  SetSummaryRequest,
  ListPeersRequest,
  SendMessageRequest,
  SetGroupsRequest,
  Peer,
  GroupSummary,
} from "./shared/types.ts";

export const encoder = new TextEncoder();

function encode(s: string): Uint8Array {
  return encoder.encode(s);
}

export function logPeerRemoved(id: string, reason: string): void {
  console.error(`[claude-peers broker] peer removed: id=${id} reason=${reason}`);
}

// alias / machine / group 조각 정규화. `:`는 peer_id 구분자라 제거.
export function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/:/g, "");
}

// peer_id 정규화: `machine:alias`에서 양쪽 조각만 정규화하고 `:`는 보존.
export function normalizePeerId(peerId: string): string {
  const idx = peerId.indexOf(":");
  if (idx === -1) return normalize(peerId);
  const machine = normalize(peerId.slice(0, idx));
  const alias = normalize(peerId.slice(idx + 1));
  return `${machine}:${alias}`;
}

function hasIntersection(a: string[], b: string[]): boolean {
  for (const x of a) if (b.includes(x)) return true;
  return false;
}

function intersection(a: string[], b: string[]): string[] {
  return a.filter((x) => b.includes(x));
}

interface PeerEntry {
  id: string; // `machine:alias`
  machine: string;
  cwd: string;
  summary: string;
  registered_at: string;
  groups: string[];
  controller: ReadableStreamDefaultController;
}

// 모듈 레벨 메모리 map — 테스트에서 peers.clear()로 초기화
export const peers = new Map<string, PeerEntry>();

export function createHandlers() {
  function handleRegister(
    body: RegisterRequest,
    controller: ReadableStreamDefaultController,
  ): RegisterResponse {
    const alias = normalize(body.id);
    const machine = normalize(body.machine);
    if (!alias) {
      throw new Error("alias must not be empty");
    }
    if (!machine) {
      throw new Error("machine must not be empty");
    }
    const id = `${machine}:${alias}`;
    const now = new Date().toISOString();

    // 같은 peer_id 재등록 시 이전 SSE 닫기 (좀비 방지)
    const existing = peers.get(id);
    if (existing) {
      try { existing.controller.close(); } catch { /* already closed */ }
      peers.delete(id);
      logPeerRemoved(id, "re-registered");
    }

    const entry: PeerEntry = {
      id,
      machine,
      cwd: body.cwd,
      summary: body.summary,
      registered_at: now,
      groups: [machine],
      controller,
    };
    peers.set(id, entry);

    // 첫 SSE 이벤트: 등록 완료
    controller.enqueue(encode(`data: ${JSON.stringify({ type: "registered", id })}\n\n`));

    return { id };
  }

  function handleSetSummary(body: SetSummaryRequest): void {
    const entry = peers.get(normalizePeerId(body.id));
    if (entry) {
      entry.summary = body.summary;
    }
  }

  function handleSetGroups(body: SetGroupsRequest): { ok: boolean; groups?: string[]; error?: string } {
    const entry = peers.get(normalizePeerId(body.id));
    if (!entry) {
      return { ok: false, error: `Peer ${body.id} not found` };
    }

    const normalized = body.groups.map((g) => normalize(g)).filter((g) => g.length > 0);
    const unique = [...new Set(normalized)];
    if (unique.length === 0) {
      return { ok: false, error: "groups must not be empty" };
    }
    entry.groups = unique;
    return { ok: true, groups: unique };
  }

  function handleListPeers(body: ListPeersRequest): Peer[] {
    const callerId = normalizePeerId(body.id);
    const caller = peers.get(callerId);
    if (!caller) return [];

    const result: Peer[] = [];
    for (const entry of peers.values()) {
      if (entry.id === callerId) continue;
      const matched = intersection(caller.groups, entry.groups);
      if (matched.length === 0) continue;

      result.push({
        id: entry.id,
        cwd: entry.cwd,
        summary: entry.summary,
        registered_at: entry.registered_at,
        matched_groups: matched,
      });
    }
    return result;
  }

  function handleListGroups(): GroupSummary[] {
    const counts = new Map<string, number>();
    for (const entry of peers.values()) {
      for (const g of entry.groups) {
        counts.set(g, (counts.get(g) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .map(([name, peer_count]) => ({ name, peer_count }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function handleSendMessage(body: SendMessageRequest): { ok: boolean; error?: string } {
    const sender = peers.get(normalizePeerId(body.from_id));
    const target = peers.get(normalizePeerId(body.to_id));

    // 그룹 격리: 발신자/수신자가 그룹 교집합 없거나 둘 중 하나가 없으면
    // 미등록 피어와 동일한 응답으로 위장 (그룹 멤버십 누설 방지)
    if (!sender || !target || !hasIntersection(sender.groups, target.groups)) {
      return { ok: false, error: `Peer ${body.to_id} not found` };
    }

    const event: Record<string, unknown> = {
      type: "message",
      from_id: sender.id,
      text: body.text,
      sent_at: new Date().toISOString(),
    };
    if (body.skill) event.skill = body.skill;

    try {
      target.controller.enqueue(encode(`data: ${JSON.stringify(event)}\n\n`));
    } catch {
      peers.delete(target.id);
      logPeerRemoved(target.id, "send-failed");
      return { ok: false, error: `Peer ${body.to_id} not found` };
    }

    return { ok: true };
  }

  function handleUnregister(body: { id: string }): void {
    const id = normalizePeerId(body.id);
    const entry = peers.get(id);
    if (entry) {
      try { entry.controller.close(); } catch { /* already closed */ }
      peers.delete(id);
      logPeerRemoved(id, "unregistered");
    }
  }

  return {
    handleRegister,
    handleSetSummary,
    handleSetGroups,
    handleListPeers,
    handleListGroups,
    handleSendMessage,
    handleUnregister,
  };
}
