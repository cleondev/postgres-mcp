# postgres-mcp

A small PostgreSQL [MCP](https://modelcontextprotocol.io) server for Claude Code and other MCP clients,
built to be safe to point at a shared database.

- **Read-only by default.** Write tools exist only when `PG_MCP_MODE=readwrite`.
- **One statement per call.** Every statement goes through the extended query protocol, which rejects
  `select 1; drop table t`. Transaction control (`COMMIT`, `BEGIN`, `SET TRANSACTION`, ...) is refused.
- **Every call is its own transaction.** Reads run in `REPEATABLE READ READ ONLY` with a snapshot taken
  first, then always roll back; the session also defaults to `default_transaction_read_only=on`.
- **Bounded.** `statement_timeout` on every call; reads go through a cursor and fetch at most
  `PG_MCP_MAX_ROWS + 1` rows; long cells and `bytea` are summarised.
- **No password on the command line.** Arguments are refused; the connection string comes from the
  environment, so it does not show up in `ps` or Task Manager.
- **Pinned.** Exact dependency versions, a committed `package-lock.json`, and `ignore-scripts=true`.

Written after reviewing `@sarmadparvez/postgresql-mcp@1.0.8`, whose `query` tool could be escaped with
`COMMIT; <write>` because it sent the SQL with the simple query protocol. No code is shared.

## Tools

| Tool | Mode | What it does |
|---|---|---|
| `query` | always | One read-only statement (`SELECT`, `WITH`, `VALUES`, `TABLE`, `SHOW`, `EXPLAIN`) |
| `list_tables` | always | Tables, views, materialized views with estimated rows and size; all user schemas by default |
| `describe_table` | always | Columns, constraints and indexes of one relation |
| `connection_info` | always | Role, mode, limits, and whether the role itself could write |
| `execute` | readwrite | One write statement, committed; `dry_run: true` reports the effect and rolls back |
| `transaction` | readwrite | Up to 100 statements, all or nothing; supports `dry_run` |

## Install

```bash
git clone https://github.com/cleondev/postgres-mcp.git
cd postgres-mcp
npm ci
```

Requires Node.js 20 or later.

## Register with Claude Code

```bash
claude mcp add postgres-mydb --scope user \
  -e PG_MCP_URL=postgres://reader@db.example.com:5432/mydb \
  -- node /path/to/postgres-mcp/src/index.js
```

Keep the password out of `PG_MCP_URL` where you can: `pg` also reads `PGPASSWORD` and the standard
pgpass file (`~/.pgpass`, or `%APPDATA%\postgresql\pgpass.conf` on Windows).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PG_MCP_URL` (or `DATABASE_URL`) | required | `postgres://user[:password]@host:port/db` |
| `PG_MCP_MODE` | `readonly` | `readonly` or `readwrite` |
| `PG_MCP_STATEMENT_TIMEOUT_MS` | `30000` | Per-call statement timeout |
| `PG_MCP_MAX_ROWS` | `500` | Rows returned by `query` before truncation |
| `PG_MCP_MAX_CELL_CHARS` | `2000` | Characters kept per cell |

## Threat model

This server stops a model from writing by accident or by being talked into a multi-statement escape.
It cannot make a role that is allowed to write truly read-only: a function the role may call (for
example `dblink_exec`, which opens a second connection) runs outside this server's transaction.
`connection_info` and the startup log warn when that is the case.

For a hard boundary, connect `readonly` mode as a role that has only `SELECT`:

```sql
create role mydb_reader login password '...';
grant connect on database mydb to mydb_reader;
grant usage on schema app to mydb_reader;
grant select on all tables in schema app to mydb_reader;
alter default privileges for role mydb_owner in schema app grant select on tables to mydb_reader;
```

In `readwrite` mode, review each `execute`/`transaction` call before approving it; do not add those
tools to an auto-approve list.

## Tests

```bash
npm test                                         # unit tests only
PG_MCP_TEST_URL=postgres://... npm test          # plus end-to-end tests over stdio
```

The end-to-end tests touch only temporary tables, so they are safe against a shared database.

## License

MIT
