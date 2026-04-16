#!/usr/bin/env bun
/**
 * claude-peers MCP server
 *
 * Spawned by Claude Code as a stdio MCP server (one per instance).
 * Connects to the shared broker daemon for peer discovery and messaging.
 * Declares claude/channel capability to push inbound messages immediately.
 *
 * Broker must be started separately (bun broker.ts).
 * Claude controls registration/polling via register/unregister tools.
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
  RegisterResponse,
  PollMessagesResponse,
  Message,
} from "./shared/types.ts";

// --- Configuration ---

const BROKER_PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const rawBrokerUrl = process.env.CLAUDE_PEERS_BROKER_URL;
const BROKER_URL = (rawBrokerUrl && !rawBrokerUrl.startsWith("${"))
  ? rawBrokerUrl
  : `http://127.0.0.1:${BROKER_PORT}`;
const POLL_INTERVAL_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 15_000;

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
let pollTimer: Timer | null = null;
let heartbeatTimer: Timer | null = null;

// --- MCP Server ---

const mcp = new Server(
  { name: "claude-peers", version: "0.2.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: `You are connected to the claude-peers network. Other Claude Code instances can discover you and send messages.

Call "register" before using any other tools. After registering, call set_summary to describe your current work.

When you receive a <channel source="claude-peers" ...> message, RESPOND IMMEDIATELY. Pause your current task, reply via send_message with the sender's from_id, then resume. Read from_id, from_summary, and from_cwd to understand who sent it.

Only reply ONCE per message. Do not reply to acknowledgments or simple confirmations ("OK", "thanks", "got it").

When done working, call unregister to disconnect.`,
  }
);

// --- Tool definitions ---

const TOOLS = [
  {
    name: "register",
    description:
      "Register with the broker using an alias (e.g. 'planner', 'worker-a'). The alias becomes your peer ID. Call this before using any other tools. Starts polling and heartbeat automatically.",
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
      "Unregister from the broker and stop receiving messages. Stops polling and heartbeat. Call this when you are done working.",
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
            'Scope of peer discovery. "machine" = all instances on this computer. "directory" = same working directory. "repo" = same git repository (including worktrees or subdirectories).',
        },
      },
      required: ["scope"],
    },
  },
  {
    name: "send_message",
    description:
      "Send a message to another Claude Code instance by peer ID. The message will be pushed into their session immediately via channel notification.",
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
  {
    name: "check_messages",
    description:
      "Manually check for new messages from other Claude Code instances. Messages are normally pushed automatically via channel notifications, but you can use this as a fallback.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
];

// --- Polling and heartbeat ---

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(pollAndPushMessages, POLL_INTERVAL_MS);
  log("Polling started");
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    log("Polling stopped");
  }
}

function startHeartbeat() {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(async () => {
    if (myId) {
      try {
        await brokerFetch("/heartbeat", { id: myId });
      } catch {
        // Non-critical
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  log("Heartbeat started");
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    log("Heartbeat stopped");
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

      if (myId) {
        return {
          content: [{ type: "text" as const, text: `Already registered as peer ${myId}` }],
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
        const reg = await brokerFetch<RegisterResponse>("/register", {
          id: alias,
          pid: process.pid,
          cwd: myCwd,
          git_root: myGitRoot,
          tty,
          summary: "",
        });
        myId = reg.id;
        startPolling();
        startHeartbeat();
        log(`Registered as peer ${myId}`);
        return {
          content: [{
            type: "text" as const,
            text: `Registered as peer "${myId}". Polling and heartbeat started. Call set_summary to describe your current work.`,
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

      stopPolling();
      stopHeartbeat();

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
          text: `Unregistered peer ${oldId}. Polling and heartbeat stopped.`,
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
          exclude_id: myId,
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
          parts.push(`Last seen: ${p.last_seen}`);
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
      log(`send_message args: ${JSON.stringify(args)}`);
      const rawArgs = args as Record<string, string>;
      const to_id = rawArgs.to_id ?? rawArgs.to ?? rawArgs.peer_id ?? rawArgs.id;
      const message = rawArgs.message ?? rawArgs.text ?? rawArgs.msg;
      if (!to_id || !message) {
        return {
          content: [{
            type: "text" as const,
            text: `Invalid arguments. Expected to_id and message. Received: ${JSON.stringify(args)}`,
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

    case "check_messages": {
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered. Call register first." }],
          isError: true,
        };
      }
      try {
        const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });
        if (result.messages.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No new messages." }],
          };
        }
        const lines = result.messages.map(
          (m) => `From ${m.from_id} (${m.sent_at}):\n${m.text}`
        );
        return {
          content: [{
            type: "text" as const,
            text: `${result.messages.length} new message(s):\n\n${lines.join("\n\n---\n\n")}`,
          }],
        };
      } catch (e) {
        return {
          content: [{
            type: "text" as const,
            text: `Error checking messages: ${e instanceof Error ? e.message : String(e)}`,
          }],
          isError: true,
        };
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// --- Polling loop for inbound messages ---

async function pollAndPushMessages() {
  if (!myId) return;

  try {
    const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });

    for (const msg of result.messages) {
      // Look up the sender's info for context
      let fromSummary = "";
      let fromCwd = "";
      try {
        const peers = await brokerFetch<Peer[]>("/list-peers", {
          scope: "machine",
          cwd: myCwd,
          git_root: myGitRoot,
        });
        const sender = peers.find((p) => p.id === msg.from_id);
        if (sender) {
          fromSummary = sender.summary;
          fromCwd = sender.cwd;
        }
      } catch {
        // Non-critical, proceed without sender info
      }

      // Push as channel notification
      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: msg.text,
          meta: {
            from_id: msg.from_id,
            from_summary: fromSummary,
            from_cwd: fromCwd,
            sent_at: msg.sent_at,
          },
        },
      });

      log(`Pushed message from ${msg.from_id}: ${msg.text.slice(0, 80)}`);
    }
  } catch (e) {
    log(`Poll error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// --- Startup ---

async function main() {
  // 1. Gather context
  myCwd = process.cwd();
  myGitRoot = await getGitRoot(myCwd);

  log(`CWD: ${myCwd}`);
  log(`Git root: ${myGitRoot ?? "(none)"}`);
  log(`Broker URL: ${BROKER_URL}`);

  // 2. Check broker (warn only, don't crash)
  if (await isBrokerAlive()) {
    log("Broker is running");
  } else {
    log("WARNING: Broker is not running. Start it with: bun broker.ts");
  }

  // 3. Connect MCP over stdio (tools available, but register required before use)
  await mcp.connect(new StdioServerTransport());
  log("MCP connected. Waiting for register tool call.");

  // 4. Clean up on exit
  const cleanup = async () => {
    stopPolling();
    stopHeartbeat();
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

  // MCP stdio transport: stdin 닫히면 부모(Claude Code)가 종료한 것이므로 같이 종료
  process.stdin.on("end", cleanup);
  process.stdin.on("close", cleanup);
}

main().catch((e) => {
  log(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
