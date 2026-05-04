import { describe, test, expect, beforeEach } from "bun:test";
import { createHandlers, peers, normalize, DEFAULT_GROUP } from "./broker-handlers.ts";

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

// --- normalize ---

describe("normalize", () => {
  test("trim + lowercase", () => {
    expect(normalize("  BE  ")).toBe("be");
    expect(normalize("Hello")).toBe("hello");
    expect(normalize("be")).toBe("be");
  });
});

// --- register ---

describe("handleRegister", () => {
  beforeEach(() => peers.clear());

  test("신규 피어 등록 + lobby 자동 가입", () => {
    const { handlers } = setup();
    const { result } = registerPeer(handlers, "planner");
    expect(result.id).toBe("planner");
    expect(peers.get("planner")?.groups).toEqual([DEFAULT_GROUP]);
  });

  test("alias 정규화 (대소문자/공백)", () => {
    const { handlers } = setup();
    const { result } = registerPeer(handlers, "  Planner  ");
    expect(result.id).toBe("planner");
    expect(peers.has("planner")).toBe(true);
  });

  test("등록 시 첫 SSE 이벤트 전송", () => {
    const { handlers } = setup();
    const m = makeMockController();
    handlers.handleRegister(
      { id: "planner", pid: 1, cwd: "/", git_root: null, tty: null, summary: "" },
      m.controller,
    );
    expect(m.sent.length).toBe(1);
    const event = JSON.parse(m.sent[0]!.replace("data: ", "").trim());
    expect(event.type).toBe("registered");
    expect(event.id).toBe("planner");
  });

  test("재등록 시 lobby로 초기화 (멤버십 보존 없음)", () => {
    const { handlers } = setup();
    registerPeer(handlers, "planner");
    handlers.handleSetGroups({ id: "planner", groups: ["be", "fe"] });
    expect(peers.get("planner")?.groups).toEqual(["be", "fe"]);

    registerPeer(handlers, "planner");
    expect(peers.get("planner")?.groups).toEqual([DEFAULT_GROUP]);
  });

  test("재등록 시 이전 SSE controller.close() 호출", () => {
    const { handlers } = setup();
    const old = makeMockController();
    handlers.handleRegister(
      { id: "planner", pid: 1, cwd: "/old", git_root: null, tty: null, summary: "" },
      old.controller,
    );
    registerPeer(handlers, "planner", { cwd: "/new" });
    expect(old.isClosed()).toBe(true);
  });

  test("빈 alias 거부", () => {
    const { handlers } = setup();
    const m = makeMockController();
    expect(() =>
      handlers.handleRegister(
        { id: "  ", pid: 1, cwd: "/", git_root: null, tty: null, summary: "" },
        m.controller,
      ),
    ).toThrow();
  });
});

// --- setGroups ---

describe("handleSetGroups", () => {
  beforeEach(() => peers.clear());

  test("그룹 교체", () => {
    const { handlers } = setup();
    registerPeer(handlers, "p");
    const result = handlers.handleSetGroups({ id: "p", groups: ["be", "fe"] });
    expect(result.ok).toBe(true);
    expect(result.groups).toEqual(["be", "fe"]);
    expect(peers.get("p")?.groups).toEqual(["be", "fe"]);
  });

  test("그룹명 정규화 (BE/be / be 동일)", () => {
    const { handlers } = setup();
    registerPeer(handlers, "p");
    const result = handlers.handleSetGroups({ id: "p", groups: ["BE", "be ", " be"] });
    expect(result.groups).toEqual(["be"]);
  });

  test("빈 문자열/공백만 있는 그룹은 제거", () => {
    const { handlers } = setup();
    registerPeer(handlers, "p");
    const result = handlers.handleSetGroups({ id: "p", groups: ["be", "", "  "] });
    expect(result.groups).toEqual(["be"]);
  });

  test("모든 그룹이 빈 문자열이면 에러", () => {
    const { handlers } = setup();
    registerPeer(handlers, "p");
    const result = handlers.handleSetGroups({ id: "p", groups: ["", "  "] });
    expect(result.ok).toBe(false);
  });

  test("미등록 피어는 에러", () => {
    const { handlers } = setup();
    const result = handlers.handleSetGroups({ id: "ghost", groups: ["be"] });
    expect(result.ok).toBe(false);
  });
});

// --- listPeers ---

describe("handleListPeers", () => {
  beforeEach(() => peers.clear());

  test("같은 그룹(lobby) 피어만 반환, 자기 자신 제외", () => {
    const { handlers } = setup();
    registerPeer(handlers, "me");
    registerPeer(handlers, "other");
    const list = handlers.handleListPeers({ id: "me" });
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe("other");
    expect(list[0]!.matched_groups).toEqual([DEFAULT_GROUP]);
  });

  test("그룹 다르면 안 보임", () => {
    const { handlers } = setup();
    registerPeer(handlers, "me");
    registerPeer(handlers, "other");
    handlers.handleSetGroups({ id: "me", groups: ["be"] });
    handlers.handleSetGroups({ id: "other", groups: ["fe"] });
    const list = handlers.handleListPeers({ id: "me" });
    expect(list).toHaveLength(0);
  });

  test("교집합 그룹만 matched_groups에 표시 (다른 그룹 누설 X)", () => {
    const { handlers } = setup();
    registerPeer(handlers, "me");
    registerPeer(handlers, "gate");
    handlers.handleSetGroups({ id: "me", groups: ["be"] });
    handlers.handleSetGroups({ id: "gate", groups: ["be", "talk"] });
    const list = handlers.handleListPeers({ id: "me" });
    expect(list).toHaveLength(1);
    expect(list[0]!.matched_groups).toEqual(["be"]);
  });

  test("미등록 피어 호출 시 빈 배열", () => {
    const { handlers } = setup();
    registerPeer(handlers, "other");
    const list = handlers.handleListPeers({ id: "ghost" });
    expect(list).toEqual([]);
  });
});

// --- listGroups ---

describe("handleListGroups", () => {
  beforeEach(() => peers.clear());

  test("활성 그룹과 인원수 반환", () => {
    const { handlers } = setup();
    registerPeer(handlers, "a");
    registerPeer(handlers, "b");
    registerPeer(handlers, "c");
    handlers.handleSetGroups({ id: "a", groups: ["be"] });
    handlers.handleSetGroups({ id: "b", groups: ["be", "talk"] });
    handlers.handleSetGroups({ id: "c", groups: ["talk"] });

    const groups = handlers.handleListGroups();
    expect(groups).toEqual([
      { name: "be", peer_count: 2 },
      { name: "talk", peer_count: 2 },
    ]);
  });

  test("피어 없으면 빈 배열", () => {
    const { handlers } = setup();
    expect(handlers.handleListGroups()).toEqual([]);
  });
});

// --- sendMessage (그룹 격리) ---

describe("handleSendMessage", () => {
  beforeEach(() => peers.clear());

  test("같은 그룹 피어에게 전송 성공", () => {
    const { handlers } = setup();
    const recv = makeMockController();
    handlers.handleRegister(
      { id: "receiver", pid: 1, cwd: "/", git_root: null, tty: null, summary: "" },
      recv.controller,
    );
    registerPeer(handlers, "sender");

    const result = handlers.handleSendMessage({ from_id: "sender", to_id: "receiver", text: "hi" });
    expect(result.ok).toBe(true);

    // recv.sent[0] = registered, recv.sent[1] = message
    const event = JSON.parse(recv.sent[1]!.replace("data: ", "").trim());
    expect(event.type).toBe("message");
    expect(event.text).toBe("hi");
  });

  test("다른 그룹 피어에게 전송 시 'not found' 위장 응답", () => {
    const { handlers } = setup();
    registerPeer(handlers, "sender");
    registerPeer(handlers, "receiver");
    handlers.handleSetGroups({ id: "sender", groups: ["be"] });
    handlers.handleSetGroups({ id: "receiver", groups: ["fe"] });

    const result = handlers.handleSendMessage({ from_id: "sender", to_id: "receiver", text: "hi" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("receiver");
    expect(result.error).toContain("not found");
  });

  test("정말 없는 피어에게 전송 시 동일한 'not found' 응답", () => {
    const { handlers } = setup();
    registerPeer(handlers, "sender");
    const result = handlers.handleSendMessage({ from_id: "sender", to_id: "ghost", text: "hi" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ghost");
    expect(result.error).toContain("not found");
  });

  test("게이트 시나리오: 다중 그룹 피어가 양쪽과 통신 가능", () => {
    const { handlers } = setup();
    const aRecv = makeMockController();
    const dRecv = makeMockController();
    handlers.handleRegister(
      { id: "a", pid: 1, cwd: "/", git_root: null, tty: null, summary: "" },
      aRecv.controller,
    );
    handlers.handleRegister(
      { id: "d", pid: 1, cwd: "/", git_root: null, tty: null, summary: "" },
      dRecv.controller,
    );
    registerPeer(handlers, "g");
    handlers.handleSetGroups({ id: "a", groups: ["talk"] });
    handlers.handleSetGroups({ id: "g", groups: ["my-team", "talk"] });
    handlers.handleSetGroups({ id: "d", groups: ["my-team"] });

    expect(handlers.handleSendMessage({ from_id: "a", to_id: "g", text: "hi" }).ok).toBe(true);
    expect(handlers.handleSendMessage({ from_id: "g", to_id: "d", text: "hi" }).ok).toBe(true);
    expect(handlers.handleSendMessage({ from_id: "a", to_id: "d", text: "hi" }).ok).toBe(false);
  });

  test("skill 옵션 전달", () => {
    const { handlers } = setup();
    const recv = makeMockController();
    handlers.handleRegister(
      { id: "receiver", pid: 1, cwd: "/", git_root: null, tty: null, summary: "" },
      recv.controller,
    );
    registerPeer(handlers, "sender");

    handlers.handleSendMessage({ from_id: "sender", to_id: "receiver", text: "code", skill: "review" });
    const event = JSON.parse(recv.sent[1]!.replace("data: ", "").trim());
    expect(event.skill).toBe("review");
  });
});

// --- unregister ---

describe("handleUnregister", () => {
  beforeEach(() => peers.clear());

  test("피어 map에서 삭제 + controller.close()", () => {
    const { handlers } = setup();
    const mock = makeMockController();
    handlers.handleRegister(
      { id: "peer", pid: 1, cwd: "/", git_root: null, tty: null, summary: "" },
      mock.controller,
    );
    handlers.handleUnregister({ id: "peer" });
    expect(peers.has("peer")).toBe(false);
    expect(mock.isClosed()).toBe(true);
  });

  test("미등록 피어 unregister는 무시", () => {
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
    registerPeer(handlers, "other");
    handlers.handleSetSummary({ id: "peer", summary: "리뷰 중" });
    const list = handlers.handleListPeers({ id: "other" });
    expect(list[0]!.summary).toBe("리뷰 중");
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
