// Unique ID for each Claude Code instance (generated on registration)
export type PeerId = string;

export interface Peer {
  id: PeerId; // `machine:alias` 형식
  cwd: string;
  summary: string;
  registered_at: string;
  matched_groups: string[];
}

// --- Broker API types ---

export interface RegisterRequest {
  id: string; // alias (broker가 machine과 결합해 peer_id 생성)
  machine: string;
  cwd: string;
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
  id: PeerId;
}

export interface SendMessageRequest {
  from_id: PeerId;
  to_id: PeerId;
  text: string;
  skill?: string;
}

export interface SetGroupsRequest {
  id: PeerId;
  groups: string[];
}

export interface ListGroupsRequest {
  id: PeerId;
}

export interface GroupSummary {
  name: string;
  peer_count: number;
}

// --- SSE 이벤트 타입 (브로커 → MCP서버) ---

export interface SSERegisteredEvent {
  type: "registered";
  id: string;
}

export interface SSEMessageEvent {
  type: "message";
  from_id: string;
  text: string;
  sent_at: string;
  skill?: string;
}

export type SSEEvent = SSERegisteredEvent | SSEMessageEvent;
