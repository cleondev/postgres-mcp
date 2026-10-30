import { z } from "zod";
import { UserError } from "./db.js";
import { errorResult, formatRows, textResult } from "./format.js";

const RELATION_KINDS = `case c.relkind
    when 'r' then 'table' when 'p' then 'partitioned table' when 'v' then 'view'
    when 'm' then 'materialized view' when 'f' then 'foreign table' end`;

const USER_SCHEMAS = `n.nspname not in ('pg_catalog', 'information_schema')
    and n.nspname not like 'pg\\_toast%' and n.nspname not like 'pg\\_temp%'`;

const CONSTRAINT_KINDS = { p: "primary key", f: "foreign key", u: "unique", c: "check", x: "exclusion", t: "trigger", n: "not null" };

export const SAFETY_SQL = `select
    current_user as "user",
    current_database() as database,
    current_setting('server_version') as server_version,
    current_setting('search_path') as search_path,
    (select rolsuper from pg_roles where rolname = current_user) as superuser,
    exists (
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p') and ${USER_SCHEMAS}
        and (has_table_privilege(c.oid, 'INSERT') or has_table_privilege(c.oid, 'UPDATE')
          or has_table_privilege(c.oid, 'DELETE') or has_table_privilege(c.oid, 'TRUNCATE'))
    ) as role_can_write_tables,
    exists (
      select 1 from pg_namespace n where ${USER_SCHEMAS} and has_schema_privilege(n.oid, 'CREATE')
    ) as role_can_create_objects,
    exists (select 1 from pg_extension where extname = 'dblink') as dblink_installed`;

/** Why the role, not just this server, decides whether a read-only session is truly read-only. */
export function safetyWarnings(info, mode) {
  if (mode !== "readonly") return [];
  const warnings = [];
  if (info.superuser) warnings.push("The role is a superuser.");
  if (info.role_can_write_tables || info.role_can_create_objects) {
    warnings.push("The role itself can write; read-only is enforced per transaction by this server, not by the database.");
  }
  if (info.dblink_installed && (info.superuser || info.role_can_write_tables)) {
    warnings.push("dblink is installed: a query can open a second connection that is not read-only.");
  }
  if (warnings.length > 0) warnings.push("For a hard boundary, connect as a role that has only SELECT.");
  return warnings;
}

function guarded(handler) {
  return async (args) => {
    try {
      return await handler(args);
    } catch (err) {
      if (!(err instanceof UserError) && !err.code) console.error(`[postgres-mcp] ${err.stack ?? err.message}`);
      return errorResult(err);
    }
  };
}

export function registerTools(server, db, config) {
  const limits = { maxRows: config.maxRows, maxCellChars: config.maxCellChars };

  server.registerTool(
    "query",
    {
      title: "Run read-only SQL",
      description:
        `Run ONE read-only SQL statement (SELECT, WITH, VALUES, TABLE, SHOW, EXPLAIN) in a READ ONLY transaction ` +
        `that is always rolled back. Returns at most ${config.maxRows} rows; long cells are cut. ` +
        `Multiple statements and transaction control are rejected.`,
      inputSchema: { sql: z.string().min(1).describe("A single SQL statement") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(async ({ sql }) => textResult(formatRows(await db.readQuery(sql, config.maxRows), limits)))
  );

  server.registerTool(
    "list_tables",
    {
      title: "List tables",
      description: "List tables, views and materialized views with estimated row counts and size. Omit schema to list every user schema.",
      inputSchema: { schema: z.string().optional().describe("Schema name; omit for all user schemas") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(async ({ schema }) => {
      const result = await db.catalogQuery(
        `select n.nspname as schema, c.relname as name, ${RELATION_KINDS} as kind,
            case when c.reltuples < 0 then null else c.reltuples::bigint end as estimated_rows,
            pg_size_pretty(pg_total_relation_size(c.oid)) as size,
            obj_description(c.oid, 'pg_class') as comment
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where c.relkind in ('r', 'p', 'v', 'm', 'f') and ${USER_SCHEMAS}
           and ($1::text is null or n.nspname = $1)
         order by 1, 2`,
        [schema ?? null]
      );
      return textResult(formatRows(result, { ...limits, maxRows: 5_000 }));
    })
  );

  server.registerTool(
    "describe_table",
    {
      title: "Describe a table",
      description: "Columns (type, nullability, default, comment), constraints and indexes of one table or view.",
      inputSchema: {
        table: z.string().min(1).describe("Table or view name, unquoted"),
        schema: z.string().optional().describe("Schema name; required when the name exists in several schemas"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(async ({ table, schema }) => {
      const found = await db.catalogQuery(
        `select c.oid::text as oid, n.nspname as schema, ${RELATION_KINDS} as kind
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where c.relname = $1 and c.relkind in ('r', 'p', 'v', 'm', 'f') and ${USER_SCHEMAS}
           and ($2::text is null or n.nspname = $2)`,
        [table, schema ?? null]
      );
      if (found.rows.length === 0) throw new UserError(`No table or view named "${table}"${schema ? ` in schema "${schema}"` : ""}.`);
      if (found.rows.length > 1) {
        throw new UserError(`"${table}" exists in several schemas (${found.rows.map((r) => r.schema).join(", ")}); pass schema.`);
      }
      const { oid, kind } = found.rows[0];
      const [columns, constraints, indexes] = await Promise.all([
        db.catalogQuery(
          `select a.attname as name, format_type(a.atttypid, a.atttypmod) as type, not a.attnotnull as nullable,
              pg_get_expr(d.adbin, d.adrelid) as "default", col_description(a.attrelid, a.attnum) as comment
           from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
           where a.attrelid = $1::oid and a.attnum > 0 and not a.attisdropped order by a.attnum`,
          [oid]
        ),
        db.catalogQuery(
          `select conname as name, contype as kind, pg_get_constraintdef(oid) as definition
           from pg_constraint where conrelid = $1::oid order by contype, conname`,
          [oid]
        ),
        db.catalogQuery(
          `select indexrelid::regclass::text as name, pg_get_indexdef(indexrelid) as definition
           from pg_index where indrelid = $1::oid order by 1`,
          [oid]
        ),
      ]);
      return textResult({
        schema: found.rows[0].schema,
        name: table,
        kind,
        columns: columns.rows,
        constraints: constraints.rows.map((c) => ({ ...c, kind: CONSTRAINT_KINDS[c.kind] ?? c.kind })),
        indexes: indexes.rows,
      });
    })
  );

  server.registerTool(
    "connection_info",
    {
      title: "Connection and safety info",
      description: "Who this server connects as, its mode and limits, and whether the database role itself could write.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(async () => {
      const info = (await db.catalogQuery(SAFETY_SQL)).rows[0];
      return textResult({
        ...info,
        host: config.host,
        mode: config.mode,
        statement_timeout_ms: config.statementTimeoutMs,
        max_rows: config.maxRows,
        warnings: safetyWarnings(info, config.mode),
      });
    })
  );

  if (config.mode !== "readwrite") return;

  const writeAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
  const dryRun = z.boolean().optional().default(false).describe("Run it, report the effect, then roll back");

  const summarise = (results, dry) =>
    textResult({
      committed: !dry,
      ...(dry ? { note: "dry_run: every change was rolled back." } : {}),
      statements: results.map((r) => ({
        command: r.command,
        rowCount: r.rowCount ?? 0,
        ...(r.rows?.length ? { returned: formatRows(r, limits) } : {}),
      })),
    });

  server.registerTool(
    "execute",
    {
      title: "Execute one write statement",
      description:
        "Run ONE write statement (INSERT, UPDATE, DELETE, DDL) in its own transaction and commit it. " +
        "Use dry_run=true first to see the row count without keeping the change.",
      inputSchema: { sql: z.string().min(1).describe("A single SQL statement"), dry_run: dryRun },
      annotations: writeAnnotations,
    },
    guarded(async ({ sql, dry_run }) => summarise(await db.write([sql], { dryRun: dry_run }), dry_run))
  );

  server.registerTool(
    "transaction",
    {
      title: "Execute statements atomically",
      description:
        "Run several statements, one per array item, in a single transaction: all commit or none do. " +
        "Use dry_run=true to preview the effect and roll everything back.",
      inputSchema: {
        statements: z.array(z.string().min(1)).min(1).max(100).describe("One SQL statement per item, run in order"),
        dry_run: dryRun,
      },
      annotations: writeAnnotations,
    },
    guarded(async ({ statements, dry_run }) => summarise(await db.write(statements, { dryRun: dry_run }), dry_run))
  );
}
