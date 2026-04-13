/**
 * Broker handler logic — separated for testability.
 * All handlers receive a Database instance and staleTimeoutMs.
 */

import { Database } from "bun:sqlite";
import type {
  RegisterRequest,
  RegisterResponse,
  HeartbeatRequest,
  SetSummaryRequest,
  ListPeersRequest,
  SendMessageRequest,
  PollMessagesRequest,
  PollMessagesResponse,
  Peer,
  Message,
} from "./shared/types.ts";

export function initSchema(db: Database) {
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 3000");

  db.run(`
    CREATE TABLE IF NOT EXISTS peers (
      id TEXT PRIMARY KEY,
      pid INTEGER NOT NULL,
      cwd TEXT NOT NULL,
      git_root TEXT,
      tty TEXT,
      summary TEXT NOT NULL DEFAULT '',
      registered_at TEXT NOT NULL,
      last_seen TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      text TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      delivered INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (from_id) REFERENCES peers(id),
      FOREIGN KEY (to_id) REFERENCES peers(id)
    )
  `);
}

export function createHandlers(db: Database, staleTimeoutMs: number) {
  const insertPeer = db.prepare(`
    INSERT INTO peers (id, pid, cwd, git_root, tty, summary, registered_at, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateLastSeen = db.prepare(`UPDATE peers SET last_seen = ? WHERE id = ?`);
  const updateSummary = db.prepare(`UPDATE peers SET summary = ? WHERE id = ?`);
  const deletePeer = db.prepare(`DELETE FROM peers WHERE id = ?`);
  const selectAllPeers = db.prepare(`SELECT * FROM peers`);
  const selectPeersByDirectory = db.prepare(`SELECT * FROM peers WHERE cwd = ?`);
  const selectPeersByGitRoot = db.prepare(`SELECT * FROM peers WHERE git_root = ?`);
  const insertMessage = db.prepare(`
    INSERT INTO messages (from_id, to_id, text, sent_at, delivered)
    VALUES (?, ?, ?, ?, 0)
  `);
  const selectUndelivered = db.prepare(`
    SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY sent_at ASC
  `);
  const markDelivered = db.prepare(`UPDATE messages SET delivered = 1 WHERE id = ?`);

  function handleRegister(body: RegisterRequest): RegisterResponse {
    const id = body.id;
    const now = new Date().toISOString();
    const existing = db.query("SELECT id FROM peers WHERE id = ?").get(id) as { id: string } | null;
    if (existing) {
      deletePeer.run(existing.id);
    }
    insertPeer.run(id, body.pid, body.cwd, body.git_root, body.tty, body.summary, now, now);
    return { id };
  }

  function handleHeartbeat(body: HeartbeatRequest): void {
    updateLastSeen.run(new Date().toISOString(), body.id);
  }

  function handleSetSummary(body: SetSummaryRequest): void {
    updateSummary.run(body.summary, body.id);
  }

  function handleListPeers(body: ListPeersRequest): Peer[] {
    let peers: Peer[];
    switch (body.scope) {
      case "machine":
        peers = selectAllPeers.all() as Peer[];
        break;
      case "directory":
        peers = selectPeersByDirectory.all(body.cwd) as Peer[];
        break;
      case "repo":
        if (body.git_root) {
          peers = selectPeersByGitRoot.all(body.git_root) as Peer[];
        } else {
          peers = selectPeersByDirectory.all(body.cwd) as Peer[];
        }
        break;
      default:
        peers = selectAllPeers.all() as Peer[];
    }
    if (body.exclude_id) {
      peers = peers.filter((p) => p.id !== body.exclude_id);
    }
    const cutoff = new Date(Date.now() - staleTimeoutMs).toISOString();
    return peers.filter((p) => p.last_seen >= cutoff);
  }

  function handleSendMessage(body: SendMessageRequest): { ok: boolean; error?: string } {
    const target = db.query("SELECT id FROM peers WHERE id = ?").get(body.to_id) as { id: string } | null;
    if (!target) {
      return { ok: false, error: `Peer ${body.to_id} not found` };
    }
    insertMessage.run(body.from_id, body.to_id, body.text, new Date().toISOString());
    return { ok: true };
  }

  function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
    const messages = selectUndelivered.all(body.id) as Message[];
    for (const msg of messages) {
      markDelivered.run(msg.id);
    }
    return { messages };
  }

  function handleUnregister(body: { id: string }): void {
    deletePeer.run(body.id);
  }

  function cleanStalePeers(): void {
    const cutoff = new Date(Date.now() - staleTimeoutMs).toISOString();
    const stale = db.query("SELECT id FROM peers WHERE last_seen < ?").all(cutoff) as { id: string }[];
    for (const peer of stale) {
      db.run("DELETE FROM peers WHERE id = ?", [peer.id]);
      db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [peer.id]);
    }
  }

  return {
    handleRegister,
    handleHeartbeat,
    handleSetSummary,
    handleListPeers,
    handleSendMessage,
    handlePollMessages,
    handleUnregister,
    cleanStalePeers,
  };
}
