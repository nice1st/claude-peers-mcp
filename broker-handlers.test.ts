import { describe, test, expect, beforeEach } from "bun:test";
import { createHandlers, peers, normalize, normalizePeerId } from "./broker-handlers.ts";

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
  alias: string,
  opts?: { machine?: string; cwd?: string },
) {
  const { controller } = makeMockController();
  return {
    result: handlers.handleRegister(
      {
        id: alias,
        machine: opts?.machine ?? "machine-a",
        cwd: opts?.cwd ?? "/test",
        summary: "",
      },
      controller,
    ),
    controller,
  };
}

// --- normalize ---

describe("normalize", () => {
  test("trim + lowercase + colon 제거", () => {
    expect(normalize("  BE  ")).toBe("be");
    expect(normalize("Hello")).toBe("hello");
    expect(normalize("a:b:c")).toBe("abc");
  });
});

describe("normalizePeerId", () => {
  test("첫 colon은 구분자로 보존, 양쪽 조각만 정규화", () => {
    expect(normalizePeerId("Machine-A:Analyst")).toBe("machine-a:analyst");
    expect(normalizePeerId("  MAC : My:Alias ")).toBe("mac:myalias");
  });

  test("colon 없으면 전체 정규화", () => {
    expect(normalizePeerId("Planner")).toBe("planner");
  });
});

// --- register ---

describe("handleRegister", () => {
  beforeEach(() => peers.clear());

  test("peer_id = machine:alias, 디폴트 그룹 = [machine]", () => {
    const { handlers } = setup();
    const { result } = registerPeer(handlers, "analyst", { machine: "machine-a" });
    expect(result.id).toBe("machine-a:analyst");
    expect(peers.get("machine-a:analyst")?.groups).toEqual(["machine-a"]);
  });

  test("alias/machine 정규화 (대소문자/공백/colon)", () => {
    const { handlers } = setup();
    const { result } = registerPeer(handlers, "  Ana:lyst  ", { machine: "  Machine-A  " });
    expect(result.id).toBe("machine-a:analyst");
  });

  test("같은 alias 다른 머신 → 공존", () => {
    const { handlers } = setup();
    registerPeer(handlers, "analyst", { machine: "machine-a" });
    registerPeer(handlers, "analyst", { machine: "machine-b" });
    expect(peers.has("machine-a:analyst")).toBe(true);
    expect(peers.has("machine-b:analyst")).toBe(true);
    expect(peers.size).toBe(2);
  });

  test("같은 머신 같은 alias → 교체 (이전 controller.close)", () => {
    const { handlers } = setup();
    const old = makeMockController();
    handlers.handleRegister(
      { id: "analyst", machine: "machine-a", cwd: "/old", summary: "" },
      old.controller,
    );
    registerPeer(handlers, "analyst", { machine: "machine-a", cwd: "/new" });
    expect(old.isClosed()).toBe(true);
    expect(peers.size).toBe(1);
  });

  test("빈 alias 거부", () => {
    const { handlers } = setup();
    const m = makeMockController();
    expect(() =>
      handlers.handleRegister({ id: "  ", machine: "machine-a", cwd: "/", summary: "" }, m.controller),
    ).toThrow();
  });

  test("빈 machine 거부", () => {
    const { handlers } = setup();
    const m = makeMockController();
    expect(() =>
      handlers.handleRegister({ id: "analyst", machine: "  ", cwd: "/", summary: "" }, m.controller),
    ).toThrow();
  });
});

// --- setGroups ---

describe("handleSetGroups", () => {
  beforeEach(() => peers.clear());

  test("그룹 교체", () => {
    const { handlers } = setup();
    registerPeer(handlers, "p", { machine: "m" });
    const result = handlers.handleSetGroups({ id: "m:p", groups: ["be", "fe"] });
    expect(result.ok).toBe(true);
    expect(result.groups).toEqual(["be", "fe"]);
  });

  test("그룹명 정규화", () => {
    const { handlers } = setup();
    registerPeer(handlers, "p", { machine: "m" });
    const result = handlers.handleSetGroups({ id: "m:p", groups: ["BE", "be ", " be"] });
    expect(result.groups).toEqual(["be"]);
  });

  test("모든 그룹이 빈 문자열이면 에러", () => {
    const { handlers } = setup();
    registerPeer(handlers, "p", { machine: "m" });
    const result = handlers.handleSetGroups({ id: "m:p", groups: ["", "  "] });
    expect(result.ok).toBe(false);
  });

  test("미등록 피어는 에러", () => {
    const { handlers } = setup();
    const result = handlers.handleSetGroups({ id: "m:ghost", groups: ["be"] });
    expect(result.ok).toBe(false);
  });
});

// --- listPeers ---

describe("handleListPeers", () => {
  beforeEach(() => peers.clear());

  test("같은 머신 세션끼리 자동 발견 (디폴트 그룹 = machine)", () => {
    const { handlers } = setup();
    registerPeer(handlers, "analyst", { machine: "machine-a" });
    registerPeer(handlers, "planner", { machine: "machine-a" });
    const list = handlers.handleListPeers({ id: "machine-a:analyst" });
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe("machine-a:planner");
    expect(list[0]!.matched_groups).toEqual(["machine-a"]);
  });

  test("다른 머신은 기본적으로 안 보임", () => {
    const { handlers } = setup();
    registerPeer(handlers, "analyst", { machine: "machine-a" });
    registerPeer(handlers, "analyst", { machine: "machine-b" });
    const list = handlers.handleListPeers({ id: "machine-a:analyst" });
    expect(list).toHaveLength(0);
  });

  test("공유 그룹 합류 시 다른 머신과 만남 (게이트 패턴)", () => {
    const { handlers } = setup();
    registerPeer(handlers, "analyst", { machine: "machine-a" });
    registerPeer(handlers, "analyst", { machine: "machine-b" });
    handlers.handleSetGroups({ id: "machine-a:analyst", groups: ["machine-a", "shared"] });
    handlers.handleSetGroups({ id: "machine-b:analyst", groups: ["machine-b", "shared"] });

    const list = handlers.handleListPeers({ id: "machine-a:analyst" });
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe("machine-b:analyst");
    expect(list[0]!.matched_groups).toEqual(["shared"]);
  });

  test("미등록 피어 호출 시 빈 배열", () => {
    const { handlers } = setup();
    registerPeer(handlers, "other", { machine: "m" });
    const list = handlers.handleListPeers({ id: "m:ghost" });
    expect(list).toEqual([]);
  });
});

// --- listGroups ---

describe("handleListGroups", () => {
  beforeEach(() => peers.clear());

  test("활성 그룹과 인원수 반환 (머신 그룹 포함)", () => {
    const { handlers } = setup();
    registerPeer(handlers, "a", { machine: "machine-a" });
    registerPeer(handlers, "b", { machine: "machine-a" });
    registerPeer(handlers, "c", { machine: "machine-b" });

    const groups = handlers.handleListGroups();
    expect(groups).toEqual([
      { name: "machine-a", peer_count: 2 },
      { name: "machine-b", peer_count: 1 },
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

  test("같은 머신 피어에게 전송 성공", () => {
    const { handlers } = setup();
    const recv = makeMockController();
    handlers.handleRegister(
      { id: "receiver", machine: "m", cwd: "/", summary: "" },
      recv.controller,
    );
    registerPeer(handlers, "sender", { machine: "m" });

    const result = handlers.handleSendMessage({ from_id: "m:sender", to_id: "m:receiver", text: "hi" });
    expect(result.ok).toBe(true);
    const event = JSON.parse(recv.sent[1]!.replace("data: ", "").trim());
    expect(event.type).toBe("message");
    expect(event.from_id).toBe("m:sender");
    expect(event.text).toBe("hi");
  });

  test("다른 머신(그룹 미공유) 피어에게 전송 시 'not found' 위장", () => {
    const { handlers } = setup();
    registerPeer(handlers, "sender", { machine: "machine-a" });
    registerPeer(handlers, "receiver", { machine: "machine-b" });

    const result = handlers.handleSendMessage({
      from_id: "machine-a:sender",
      to_id: "machine-b:receiver",
      text: "hi",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not found");
  });

  test("정말 없는 피어에게 전송 시 동일한 'not found'", () => {
    const { handlers } = setup();
    registerPeer(handlers, "sender", { machine: "m" });
    const result = handlers.handleSendMessage({ from_id: "m:sender", to_id: "m:ghost", text: "hi" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not found");
  });

  test("게이트 시나리오: 공유 그룹으로 크로스 머신 통신", () => {
    const { handlers } = setup();
    const aRecv = makeMockController();
    const dRecv = makeMockController();
    handlers.handleRegister({ id: "a", machine: "mb", cwd: "/", summary: "" }, aRecv.controller);
    handlers.handleRegister({ id: "d", machine: "ma", cwd: "/", summary: "" }, dRecv.controller);
    registerPeer(handlers, "g", { machine: "ma" });
    // g = gate, ma 그룹 + shared 그룹
    handlers.handleSetGroups({ id: "ma:g", groups: ["ma", "shared"] });
    handlers.handleSetGroups({ id: "mb:a", groups: ["mb", "shared"] });
    // d는 ma 그룹만

    expect(handlers.handleSendMessage({ from_id: "mb:a", to_id: "ma:g", text: "hi" }).ok).toBe(true);
    expect(handlers.handleSendMessage({ from_id: "ma:g", to_id: "ma:d", text: "hi" }).ok).toBe(true);
    expect(handlers.handleSendMessage({ from_id: "mb:a", to_id: "ma:d", text: "hi" }).ok).toBe(false);
  });

  test("skill 옵션 전달", () => {
    const { handlers } = setup();
    const recv = makeMockController();
    handlers.handleRegister(
      { id: "receiver", machine: "m", cwd: "/", summary: "" },
      recv.controller,
    );
    registerPeer(handlers, "sender", { machine: "m" });

    handlers.handleSendMessage({ from_id: "m:sender", to_id: "m:receiver", text: "code", skill: "review" });
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
      { id: "peer", machine: "m", cwd: "/", summary: "" },
      mock.controller,
    );
    handlers.handleUnregister({ id: "m:peer" });
    expect(peers.has("m:peer")).toBe(false);
    expect(mock.isClosed()).toBe(true);
  });

  test("미등록 피어 unregister는 무시", () => {
    const { handlers } = setup();
    expect(() => handlers.handleUnregister({ id: "m:ghost" })).not.toThrow();
  });
});

// --- setSummary ---

describe("handleSetSummary", () => {
  beforeEach(() => peers.clear());

  test("summary 업데이트", () => {
    const { handlers } = setup();
    registerPeer(handlers, "peer", { machine: "m" });
    registerPeer(handlers, "other", { machine: "m" });
    handlers.handleSetSummary({ id: "m:peer", summary: "리뷰 중" });
    const list = handlers.handleListPeers({ id: "m:other" });
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
