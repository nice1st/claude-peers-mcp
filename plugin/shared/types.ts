// Unique ID for each Claude Code instance (generated on registration)
export type PeerId = string;

export interface Peer {
  id: PeerId;
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  registered_at: string;
}

// --- Broker API types ---

export interface RegisterRequest {
  id: string;
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
}

export interface RegisterResponse {
  id: PeerId;
}

export interface SetSummaryRequest {
  id: PeerId;
  summary: string;
}

export interface ListPeersRequest {
  scope: "machine" | "directory" | "repo";
  cwd: string;
  git_root: string | null;
  exclude_id?: PeerId;
}

export interface SendMessageRequest {
  from_id: PeerId;
  to_id: PeerId;
  text: string;
}

// --- SSE 이벤트 타입 (브로커 → MCP서버) ---

export interface SSERegisteredEvent {
  type: "registered";
  id: string;
}

export interface SSEMessageEvent {
  type: "message";
  from_id: string;
  from_summary: string;
  from_cwd: string;
  text: string;
  sent_at: string;
}

export type SSEEvent = SSERegisteredEvent | SSEMessageEvent;
