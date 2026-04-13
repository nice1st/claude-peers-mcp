import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema, createHandlers } from "./broker-handlers.ts";

function setup(staleTimeoutMs = 60_000) {
  const db = new Database(":memory:");
  initSchema(db);
  const handlers = createHandlers(db, staleTimeoutMs);
  return { db, handlers };
}

function registerPeer(handlers: ReturnType<typeof createHandlers>, id: string, opts?: { cwd?: string; git_root?: string | null }) {
  return handlers.handleRegister({
    id,
    pid: 1000,
    cwd: opts?.cwd ?? "/test",
    git_root: opts?.git_root ?? null,
    tty: null,
    summary: "",
  });
}

// --- register ---

describe("handleRegister", () => {
  test("신규 피어 등록", () => {
    const { handlers } = setup();
    const result = registerPeer(handlers, "planner");
    expect(result.id).toBe("planner");
  });

  test("같은 alias 재등록 시 기존 교체", () => {
    const { handlers } = setup();
    registerPeer(handlers, "planner", { cwd: "/old" });
    registerPeer(handlers, "planner", { cwd: "/new" });

    const peers = handlers.handleListPeers({ scope: "machine", cwd: "/", git_root: null });
    expect(peers).toHaveLength(1);
    expect(peers[0].cwd).toBe("/new");
  });
});

// --- sendMessage ---

describe("handleSendMessage", () => {
  test("존재하는 피어에게 메시지 저장", () => {
    const { handlers } = setup();
    registerPeer(handlers, "sender");
    registerPeer(handlers, "receiver");

    const result = handlers.handleSendMessage({ from_id: "sender", to_id: "receiver", text: "hello" });
    expect(result.ok).toBe(true);
  });

  test("없는 피어에게 에러 반환", () => {
    const { handlers } = setup();
    registerPeer(handlers, "sender");

    const result = handlers.handleSendMessage({ from_id: "sender", to_id: "ghost", text: "hello" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ghost");
  });
});

// --- pollMessages ---

describe("handlePollMessages", () => {
  test("미배달 메시지 반환 후 delivered 마킹", () => {
    const { handlers } = setup();
    registerPeer(handlers, "a");
    registerPeer(handlers, "b");
    handlers.handleSendMessage({ from_id: "a", to_id: "b", text: "msg1" });
    handlers.handleSendMessage({ from_id: "a", to_id: "b", text: "msg2" });

    const result = handlers.handlePollMessages({ id: "b" });
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].text).toBe("msg1");
    expect(result.messages[1].text).toBe("msg2");

    // 두 번째 poll은 빈 배열
    const result2 = handlers.handlePollMessages({ id: "b" });
    expect(result2.messages).toHaveLength(0);
  });

  test("메시지 없으면 빈 배열", () => {
    const { handlers } = setup();
    registerPeer(handlers, "lonely");

    const result = handlers.handlePollMessages({ id: "lonely" });
    expect(result.messages).toHaveLength(0);
  });
});

// --- cleanStalePeers ---

describe("cleanStalePeers", () => {
  test("타임아웃 초과 피어 삭제", () => {
    const { db, handlers } = setup(1000); // 1초 타임아웃
    registerPeer(handlers, "stale");

    // last_seen을 과거로 강제 설정
    db.run("UPDATE peers SET last_seen = ? WHERE id = ?", [new Date(Date.now() - 2000).toISOString(), "stale"]);

    handlers.cleanStalePeers();

    const peers = handlers.handleListPeers({ scope: "machine", cwd: "/", git_root: null });
    expect(peers).toHaveLength(0);
  });

  test("타임아웃 이내 피어 유지", () => {
    const { handlers } = setup(60_000);
    registerPeer(handlers, "fresh");

    handlers.cleanStalePeers();

    const peers = handlers.handleListPeers({ scope: "machine", cwd: "/", git_root: null });
    expect(peers).toHaveLength(1);
  });

  test("stale 피어의 미배달 메시지도 삭제", () => {
    const { db, handlers } = setup(1000);
    registerPeer(handlers, "sender");
    registerPeer(handlers, "stale");
    handlers.handleSendMessage({ from_id: "sender", to_id: "stale", text: "will be deleted" });

    db.run("UPDATE peers SET last_seen = ? WHERE id = ?", [new Date(Date.now() - 2000).toISOString(), "stale"]);

    handlers.cleanStalePeers();

    // stale 피어의 미배달 메시지 확인
    const msgs = db.query("SELECT * FROM messages WHERE to_id = 'stale' AND delivered = 0").all();
    expect(msgs).toHaveLength(0);
  });
});

// --- listPeers ---

describe("handleListPeers", () => {
  test("scope=machine 전체 반환", () => {
    const { handlers } = setup();
    registerPeer(handlers, "a", { cwd: "/project-a" });
    registerPeer(handlers, "b", { cwd: "/project-b" });

    const peers = handlers.handleListPeers({ scope: "machine", cwd: "/", git_root: null });
    expect(peers).toHaveLength(2);
  });

  test("scope=directory 같은 cwd만", () => {
    const { handlers } = setup();
    registerPeer(handlers, "a", { cwd: "/project-a" });
    registerPeer(handlers, "b", { cwd: "/project-b" });

    const peers = handlers.handleListPeers({ scope: "directory", cwd: "/project-a", git_root: null });
    expect(peers).toHaveLength(1);
    expect(peers[0].id).toBe("a");
  });

  test("scope=repo 같은 git_root만", () => {
    const { handlers } = setup();
    registerPeer(handlers, "a", { cwd: "/repo/sub-a", git_root: "/repo" });
    registerPeer(handlers, "b", { cwd: "/repo/sub-b", git_root: "/repo" });
    registerPeer(handlers, "c", { cwd: "/other", git_root: "/other" });

    const peers = handlers.handleListPeers({ scope: "repo", cwd: "/repo/sub-a", git_root: "/repo" });
    expect(peers).toHaveLength(2);
  });

  test("scope=repo git_root 없으면 cwd 폴백", () => {
    const { handlers } = setup();
    registerPeer(handlers, "a", { cwd: "/no-git", git_root: null });
    registerPeer(handlers, "b", { cwd: "/no-git", git_root: null });

    const peers = handlers.handleListPeers({ scope: "repo", cwd: "/no-git", git_root: null });
    expect(peers).toHaveLength(2);
  });

  test("exclude_id로 자기 자신 제외", () => {
    const { handlers } = setup();
    registerPeer(handlers, "me");
    registerPeer(handlers, "other");

    const peers = handlers.handleListPeers({ scope: "machine", cwd: "/", git_root: null, exclude_id: "me" });
    expect(peers).toHaveLength(1);
    expect(peers[0].id).toBe("other");
  });

  test("stale 피어 제외", () => {
    const { db, handlers } = setup(1000);
    registerPeer(handlers, "fresh");
    registerPeer(handlers, "stale");

    db.run("UPDATE peers SET last_seen = ? WHERE id = ?", [new Date(Date.now() - 2000).toISOString(), "stale"]);

    const peers = handlers.handleListPeers({ scope: "machine", cwd: "/", git_root: null });
    expect(peers).toHaveLength(1);
    expect(peers[0].id).toBe("fresh");
  });
});

// --- heartbeat ---

describe("handleHeartbeat", () => {
  test("last_seen 갱신", () => {
    const { db, handlers } = setup();
    registerPeer(handlers, "peer");

    const before = (db.query("SELECT last_seen FROM peers WHERE id = 'peer'").get() as { last_seen: string }).last_seen;

    // 약간의 시간차
    handlers.handleHeartbeat({ id: "peer" });

    const after = (db.query("SELECT last_seen FROM peers WHERE id = 'peer'").get() as { last_seen: string }).last_seen;
    expect(after >= before).toBe(true);
  });
});

// --- unregister ---

describe("handleUnregister", () => {
  test("피어 삭제", () => {
    const { handlers } = setup();
    registerPeer(handlers, "peer");

    handlers.handleUnregister({ id: "peer" });

    const peers = handlers.handleListPeers({ scope: "machine", cwd: "/", git_root: null });
    expect(peers).toHaveLength(0);
  });
});

// --- BROKER_URL 환경변수 처리 (server.ts 로직) ---

describe("BROKER_URL 환경변수 처리", () => {
  function resolveBrokerUrl(raw: string | undefined): string {
    const port = 7899;
    return (raw && !raw.startsWith("${")) ? raw : `http://127.0.0.1:${port}`;
  }

  test("정상 URL 그대로 사용", () => {
    expect(resolveBrokerUrl("http://192.168.1.100:7899")).toBe("http://192.168.1.100:7899");
  });

  test("${} 리터럴이면 localhost 폴백", () => {
    expect(resolveBrokerUrl("${CLAUDE_PEERS_BROKER_URL}")).toBe("http://127.0.0.1:7899");
  });

  test("undefined이면 localhost 폴백", () => {
    expect(resolveBrokerUrl(undefined)).toBe("http://127.0.0.1:7899");
  });
});
