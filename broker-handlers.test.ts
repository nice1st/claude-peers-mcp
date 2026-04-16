import { describe, test, expect, beforeEach } from "bun:test";
import { createHandlers, peers } from "./broker-handlers.ts";

function makeMockController() {
  const sent: string[] = [];
  let closed = false;
  const controller = {
    enqueue: (chunk: Uint8Array) => sent.push(new TextDecoder().decode(chunk)),
    close: () => { closed = true; },
  } as unknown as ReadableStreamDefaultController;
  return { controller, sent, isClosed: () => closed };
}

function setup() {
  peers.clear();
  const handlers = createHandlers();
  return { handlers };
}

function registerPeer(
  handlers: ReturnType<typeof createHandlers>,
  id: string,
  opts?: { cwd?: string; git_root?: string | null },
) {
  const { controller } = makeMockController();
  return {
    result: handlers.handleRegister(
      {
        id,
        pid: 1000,
        cwd: opts?.cwd ?? "/test",
        git_root: opts?.git_root ?? null,
        tty: null,
        summary: "",
      },
      controller,
    ),
    controller,
  };
}

// --- register ---

describe("handleRegister", () => {
  beforeEach(() => peers.clear());

  test("신규 피어 등록", () => {
    const { handlers } = setup();
    const { result } = registerPeer(handlers, "planner");
    expect(result.id).toBe("planner");
    expect(peers.has("planner")).toBe(true);
  });

  test("등록 시 첫 SSE 이벤트 전송", () => {
    const { handlers } = setup();
    const { controller, sent } = (() => {
      const m = makeMockController();
      handlers.handleRegister(
        { id: "planner", pid: 1, cwd: "/", git_root: null, tty: null, summary: "" },
        m.controller,
      );
      return m;
    })();
    expect(sent.length).toBe(1);
    const event = JSON.parse(sent[0].replace("data: ", "").trim());
    expect(event.type).toBe("registered");
    expect(event.id).toBe("planner");
  });

  test("재등록 시 이전 SSE controller.close() 호출 (좀비 방지)", () => {
    const { handlers } = setup();
    const old = makeMockController();
    handlers.handleRegister(
      { id: "planner", pid: 1, cwd: "/old", git_root: null, tty: null, summary: "" },
      old.controller,
    );
    expect(old.isClosed()).toBe(false);

    registerPeer(handlers, "planner", { cwd: "/new" });
    expect(old.isClosed()).toBe(true);

    const peerList = handlers.handleListPeers({ scope: "machine", cwd: "/", git_root: null });
    expect(peerList).toHaveLength(1);
    expect(peerList[0].cwd).toBe("/new");
  });
});

// --- sendMessage ---

describe("handleSendMessage", () => {
  beforeEach(() => peers.clear());

  test("존재하는 피어에게 메시지 → SSE 이벤트 enqueue", () => {
    const { handlers } = setup();
    const { controller: receiverCtrl, sent } = makeMockController();
    handlers.handleRegister(
      { id: "receiver", pid: 1, cwd: "/", git_root: null, tty: null, summary: "" },
      receiverCtrl,
    );
    registerPeer(handlers, "sender");

    const result = handlers.handleSendMessage({ from_id: "sender", to_id: "receiver", text: "hello" });
    expect(result.ok).toBe(true);

    // sent[0] = registered 이벤트, sent[1] = message 이벤트
    expect(sent.length).toBe(2);
    const event = JSON.parse(sent[1].replace("data: ", "").trim());
    expect(event.type).toBe("message");
    expect(event.from_id).toBe("sender");
    expect(event.text).toBe("hello");
  });

  test("없는 피어에게 에러 반환", () => {
    const { handlers } = setup();
    registerPeer(handlers, "sender");
    const result = handlers.handleSendMessage({ from_id: "sender", to_id: "ghost", text: "hello" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ghost");
  });
});

// --- listPeers ---

describe("handleListPeers", () => {
  beforeEach(() => peers.clear());

  test("scope=machine 전체 반환", () => {
    const { handlers } = setup();
    registerPeer(handlers, "a", { cwd: "/project-a" });
    registerPeer(handlers, "b", { cwd: "/project-b" });
    const list = handlers.handleListPeers({ scope: "machine", cwd: "/", git_root: null });
    expect(list).toHaveLength(2);
  });

  test("scope=directory 같은 cwd만", () => {
    const { handlers } = setup();
    registerPeer(handlers, "a", { cwd: "/project-a" });
    registerPeer(handlers, "b", { cwd: "/project-b" });
    const list = handlers.handleListPeers({ scope: "directory", cwd: "/project-a", git_root: null });
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("a");
  });

  test("scope=repo 같은 git_root만", () => {
    const { handlers } = setup();
    registerPeer(handlers, "a", { cwd: "/repo/sub-a", git_root: "/repo" });
    registerPeer(handlers, "b", { cwd: "/repo/sub-b", git_root: "/repo" });
    registerPeer(handlers, "c", { cwd: "/other", git_root: "/other" });
    const list = handlers.handleListPeers({ scope: "repo", cwd: "/repo/sub-a", git_root: "/repo" });
    expect(list).toHaveLength(2);
  });

  test("scope=repo git_root 없으면 cwd 폴백", () => {
    const { handlers } = setup();
    registerPeer(handlers, "a", { cwd: "/no-git", git_root: null });
    registerPeer(handlers, "b", { cwd: "/no-git", git_root: null });
    const list = handlers.handleListPeers({ scope: "repo", cwd: "/no-git", git_root: null });
    expect(list).toHaveLength(2);
  });

  test("exclude_id로 자기 자신 제외", () => {
    const { handlers } = setup();
    registerPeer(handlers, "me");
    registerPeer(handlers, "other");
    const list = handlers.handleListPeers({ scope: "machine", cwd: "/", git_root: null, exclude_id: "me" });
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("other");
  });
});

// --- unregister ---

describe("handleUnregister", () => {
  beforeEach(() => peers.clear());

  test("피어 map에서 삭제 + controller.close() 호출", () => {
    const { handlers } = setup();
    const mock = makeMockController();
    handlers.handleRegister(
      { id: "peer", pid: 1, cwd: "/", git_root: null, tty: null, summary: "" },
      mock.controller,
    );
    expect(peers.has("peer")).toBe(true);

    handlers.handleUnregister({ id: "peer" });
    expect(peers.has("peer")).toBe(false);
    expect(mock.isClosed()).toBe(true);
  });

  test("등록 안 된 피어 unregister → 에러 없음", () => {
    const { handlers } = setup();
    expect(() => handlers.handleUnregister({ id: "ghost" })).not.toThrow();
  });
});

// --- setSummary ---

describe("handleSetSummary", () => {
  beforeEach(() => peers.clear());

  test("summary 업데이트", () => {
    const { handlers } = setup();
    registerPeer(handlers, "peer");
    handlers.handleSetSummary({ id: "peer", summary: "리뷰 중" });
    const list = handlers.handleListPeers({ scope: "machine", cwd: "/", git_root: null });
    expect(list[0].summary).toBe("리뷰 중");
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
