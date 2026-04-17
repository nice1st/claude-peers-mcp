#!/usr/bin/env bun
/**
 * claude-peers MCP server
 *
 * Spawned by Claude Code as a stdio MCP server (one per instance).
 * Connects to the shared broker daemon for peer discovery and messaging.
 * Declares claude/channel capability to push inbound messages immediately.
 *
 * Registration opens a persistent SSE connection to the broker.
 * Inbound messages arrive via SSE and are pushed as channel notifications.
 *
 * Broker must be started separately (bun broker.ts).
 * Claude controls registration via register/unregister tools.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  PeerId,
  Peer,
  RegisterRequest,
  SSEEvent,
} from "./shared/types.ts";

// --- Configuration ---

const BROKER_PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const rawBrokerUrl = process.env.CLAUDE_PEERS_BROKER_URL;
const BROKER_URL = (rawBrokerUrl && !rawBrokerUrl.startsWith("${"))
  ? rawBrokerUrl
  : `http://127.0.0.1:${BROKER_PORT}`;

// --- Broker communication ---

async function brokerFetch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Broker error (${path}): ${res.status} ${err}`);
  }
  return res.json() as Promise<T>;
}

async function isBrokerAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${BROKER_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

// --- Utility ---

function log(msg: string) {
  console.error(`[claude-peers] ${msg}`);
}

async function getGitRoot(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code === 0) {
      return text.trim();
    }
  } catch {
    // not a git repo
  }
  return null;
}

function getTty(): string | null {
  try {
    const ppid = process.ppid;
    if (ppid) {
      const proc = Bun.spawnSync(["ps", "-o", "tty=", "-p", String(ppid)]);
      const tty = new TextDecoder().decode(proc.stdout).trim();
      if (tty && tty !== "?" && tty !== "??") {
        return tty;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

// --- State ---

let myId: PeerId | null = null;
let myCwd = process.cwd();
let myGitRoot: string | null = null;
let sseReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

// --- MCP Server ---

const mcp = new Server(
  { name: "claude-peers", version: "1.0.2" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: `You are connected to the claude-peers network. Other Claude Code instances can discover you and send messages.

Call "register" before using any other tools. After registering, call set_summary to describe your current work.

When you receive a <channel source="claude-peers" ...> message, RESPOND IMMEDIATELY. Pause your current task, reply via send_message with the sender's from_id, then resume.

Only reply ONCE per message. Do not reply to acknowledgments or simple confirmations ("OK", "thanks", "got it").

When done working, call unregister to disconnect.`,
  }
);

// --- Tool definitions ---

const TOOLS = [
  {
    name: "register",
    description:
      "Register with the broker using an alias (e.g. 'planner', 'worker-a'). The alias becomes your peer ID. Call this before using any other tools. Opens a persistent SSE connection to receive messages instantly.",
    inputSchema: {
      type: "object" as const,
      properties: {
        alias: {
          type: "string" as const,
          description: "Your peer name (e.g. 'planner', 'worker-a'). This becomes your ID for messaging.",
        },
      },
      required: ["alias"],
    },
  },
  {
    name: "unregister",
    description:
      "Unregister from the broker and stop receiving messages. Closes the SSE connection. Call this when you are done working.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "list_peers",
    description:
      "List other Claude Code instances connected to the broker. Returns their ID, working directory, git repo, and summary.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scope: {
          type: "string" as const,
          enum: ["machine", "directory", "repo"],
          description:
            'Scope of peer discovery. "machine" = all instances. "directory" = same working directory. "repo" = same git repository.',
        },
      },
      required: ["scope"],
    },
  },
  {
    name: "send_message",
    description:
      "Send a message to another Claude Code instance by peer ID. The message will be pushed into their session immediately via SSE channel notification.",
    inputSchema: {
      type: "object" as const,
      properties: {
        to_id: {
          type: "string" as const,
          description: "The peer ID of the target Claude Code instance (from list_peers)",
        },
        message: {
          type: "string" as const,
          description: "The message to send",
        },
      },
      required: ["to_id", "message"],
    },
  },
  {
    name: "set_summary",
    description:
      "Set a brief summary (1-2 sentences) of what you are currently working on. This is visible to other Claude Code instances when they list peers.",
    inputSchema: {
      type: "object" as const,
      properties: {
        summary: {
          type: "string" as const,
          description: "A 1-2 sentence summary of your current work",
        },
      },
      required: ["summary"],
    },
  },
];

// --- SSE 수신 루프 ---

async function notifySystem(content: string) {
  await mcp.notification({
    method: "notifications/claude/channel",
    params: {
      content,
      meta: { source: "claude-peers-system", sent_at: new Date().toISOString() },
    },
  });
}

async function startSSELoop(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder();
  let buf = "";
  let errorReason: string | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buf += decoder.decode(value, { stream: true });

      // SSE 이벤트는 \n\n으로 구분
      const blocks = buf.split("\n\n");
      buf = blocks.pop() ?? "";

      for (const block of blocks) {
        const line = block.trim();
        if (!line.startsWith("data:")) continue;

        let json: SSEEvent;
        try {
          json = JSON.parse(line.slice(5).trim()) as SSEEvent;
        } catch {
          continue;
        }

        if (json.type === "message") {
          await mcp.notification({
            method: "notifications/claude/channel",
            params: {
              content: json.text,
              meta: {
                from_id: json.from_id,
                sent_at: json.sent_at,
              },
            },
          });

          log(`Pushed message from ${json.from_id}: ${json.text.slice(0, 80)}`);
        }
      }
    }
  } catch (e) {
    errorReason = e instanceof Error ? e.message : String(e);
  }

  // 루프 종료: myId가 있는데 끊긴 경우 = 비정상 (브로커 다운, 네트워크 끊김 등)
  if (myId) {
    log(`SSE loop ended: ${errorReason ?? "stream closed"}`);
    try {
      await notifySystem(
        `[claude-peers-system] 브로커와의 SSE 연결이 끊겼습니다 (peer=${myId}, reason=${errorReason ?? "stream closed"}). 메시지 수신 불가. 사용자에게 이 사실을 알리고 지시를 기다리세요. 자동으로 재등록하지 마세요.`,
      );
    } catch { /* ignore */ }
  }
}

// --- Tool handlers ---

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  switch (name) {
    case "register": {
      const { alias } = args as { alias?: string };
      if (!alias) {
        return {
          content: [{ type: "text" as const, text: "alias is required. Usage: register(alias: 'planner')" }],
          isError: true,
        };
      }

      if (!(await isBrokerAlive())) {
        return {
          content: [{
            type: "text" as const,
            text: `Broker is not running at ${BROKER_URL}. Start it with: bun broker.ts`,
          }],
          isError: true,
        };
      }

      try {
        const tty = getTty();
        const body: RegisterRequest = {
          id: alias,
          pid: process.pid,
          cwd: myCwd,
          git_root: myGitRoot,
          tty,
          summary: "",
        };

        const res = await fetch(`${BROKER_URL}/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (!res.ok || !res.body) {
          const err = await res.text();
          throw new Error(`Register failed: ${res.status} ${err}`);
        }

        // SSE 스트림 읽기 시작
        const reader = res.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
        sseReader = reader;
        myId = alias;

        // 백그라운드 루프
        startSSELoop(reader);

        log(`Registered as peer ${myId} via SSE`);
        return {
          content: [{
            type: "text" as const,
            text: `Registered as peer "${myId}". Receiving messages via SSE. Call set_summary to describe your current work.`,
          }],
        };
      } catch (e) {
        return {
          content: [{
            type: "text" as const,
            text: `Failed to register: ${e instanceof Error ? e.message : String(e)}`,
          }],
          isError: true,
        };
      }
    }

    case "unregister": {
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered." }],
        };
      }

      // SSE 연결 닫기
      try { await sseReader?.cancel(); } catch { /* ignore */ }
      sseReader = null;

      try {
        await brokerFetch("/unregister", { id: myId });
        log(`Unregistered peer ${myId}`);
      } catch {
        // Best effort
      }

      const oldId = myId;
      myId = null;
      return {
        content: [{
          type: "text" as const,
          text: `Unregistered peer ${oldId}. SSE connection closed.`,
        }],
      };
    }

    case "list_peers": {
      const scope = (args as { scope: string }).scope as "machine" | "directory" | "repo";
      try {
        const peers = await brokerFetch<Peer[]>("/list-peers", {
          scope,
          cwd: myCwd,
          git_root: myGitRoot,
        });

        if (peers.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: `No other Claude Code instances found (scope: ${scope}).`,
            }],
          };
        }

        const lines = peers.map((p) => {
          const parts = [
            `ID: ${p.id}`,
            `PID: ${p.pid}`,
            `CWD: ${p.cwd}`,
          ];
          if (p.git_root) parts.push(`Repo: ${p.git_root}`);
          if (p.tty) parts.push(`TTY: ${p.tty}`);
          if (p.summary) parts.push(`Summary: ${p.summary}`);
          parts.push(`Registered: ${p.registered_at}`);
          return parts.join("\n  ");
        });

        return {
          content: [{
            type: "text" as const,
            text: `Found ${peers.length} peer(s) (scope: ${scope}):\n\n${lines.join("\n\n")}`,
          }],
        };
      } catch (e) {
        return {
          content: [{
            type: "text" as const,
            text: `Error listing peers: ${e instanceof Error ? e.message : String(e)}`,
          }],
          isError: true,
        };
      }
    }

    case "send_message": {
      const { to_id, message } = args as { to_id?: string; message?: string };
      if (!to_id || !message) {
        return {
          content: [{
            type: "text" as const,
            text: "to_id and message are required.",
          }],
          isError: true,
        };
      }
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered. Call register first." }],
          isError: true,
        };
      }
      try {
        const result = await brokerFetch<{ ok: boolean; error?: string }>("/send-message", {
          from_id: myId,
          to_id,
          text: message,
        });
        if (!result.ok) {
          return {
            content: [{ type: "text" as const, text: `Failed to send: ${result.error}` }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text" as const, text: `Message sent to peer ${to_id}` }],
        };
      } catch (e) {
        return {
          content: [{
            type: "text" as const,
            text: `Error sending message: ${e instanceof Error ? e.message : String(e)}`,
          }],
          isError: true,
        };
      }
    }

    case "set_summary": {
      const { summary } = args as { summary: string };
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered. Call register first." }],
          isError: true,
        };
      }
      try {
        await brokerFetch("/set-summary", { id: myId, summary });
        return {
          content: [{ type: "text" as const, text: `Summary updated: "${summary}"` }],
        };
      } catch (e) {
        return {
          content: [{
            type: "text" as const,
            text: `Error setting summary: ${e instanceof Error ? e.message : String(e)}`,
          }],
          isError: true,
        };
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// --- Startup ---

async function main() {
  myCwd = process.cwd();
  myGitRoot = await getGitRoot(myCwd);

  log(`CWD: ${myCwd}`);
  log(`Git root: ${myGitRoot ?? "(none)"}`);
  log(`Broker URL: ${BROKER_URL}`);

  if (await isBrokerAlive()) {
    log("Broker is running");
  } else {
    log("WARNING: Broker is not running. Start it with: bun broker.ts");
  }

  await mcp.connect(new StdioServerTransport());
  log("MCP connected. Waiting for register tool call.");

  const cleanup = async () => {
    try { await sseReader?.cancel(); } catch { /* ignore */ }
    if (myId) {
      try {
        await brokerFetch("/unregister", { id: myId });
        log("Unregistered from broker");
      } catch {
        // Best effort
      }
    }
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.stdin.on("end", cleanup);
  process.stdin.on("close", cleanup);
}

main().catch((e) => {
  log(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
