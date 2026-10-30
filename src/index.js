#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db.js";
import { formatError } from "./format.js";
import { registerTools, SAFETY_SQL, safetyWarnings } from "./tools.js";

// stdout carries the MCP protocol; every diagnostic goes to stderr.
const log = (message) => console.error(`[postgres-mcp] ${message}`);

let config;
try {
  config = loadConfig();
} catch (err) {
  log(err.message);
  process.exit(1);
}

const db = createDb(config);

try {
  const info = (await db.catalogQuery(SAFETY_SQL)).rows[0];
  log(`connected to ${config.host}/${info.database} as ${info.user} (${config.mode})`);
  for (const warning of safetyWarnings(info, config.mode)) log(`warning: ${warning}`);
} catch (err) {
  // Start anyway: the tools report the same error, which is more useful to the
  // client than a server that silently failed to launch.
  log(`startup check failed: ${formatError(err)}`);
}

const server = new McpServer({ name: `postgres-mcp-${config.database}`, version: "0.1.0" });
registerTools(server, db, config);

const shutdown = async () => {
  await db.close().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.on("close", shutdown);

await server.connect(new StdioServerTransport());
