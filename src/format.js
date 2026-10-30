// Turns pg results into compact JSON that cannot flood the model's context:
// rows are capped, long cells are cut, and binary data is summarised.

function formatCell(value, maxChars) {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return `<bytea ${value.length} bytes>`;
  if (typeof value === "string") {
    return value.length > maxChars
      ? `${value.slice(0, maxChars)}... <truncated, ${value.length} chars>`
      : value;
  }
  if (typeof value === "object") {
    const json = JSON.stringify(value);
    return json.length > maxChars ? `${json.slice(0, maxChars)}... <truncated json, ${json.length} chars>` : value;
  }
  return value;
}

export function formatRows(result, { maxRows, maxCellChars }) {
  const rows = result.rows ?? [];
  const truncated = rows.length > maxRows;
  const kept = truncated ? rows.slice(0, maxRows) : rows;
  return {
    columns: (result.fields ?? []).map((f) => f.name),
    rows: kept.map((row) =>
      Object.fromEntries(Object.entries(row).map(([k, v]) => [k, formatCell(v, maxCellChars)]))
    ),
    rowCount: kept.length,
    ...(truncated ? { truncated: true, note: `Only the first ${maxRows} rows are shown; add LIMIT/WHERE to narrow it.` } : {}),
  };
}

export function formatError(err) {
  // Only what helps fix the SQL: no stack, no connection details.
  const parts = [err.message];
  if (err.code) parts.push(`SQLSTATE ${err.code}`);
  if (err.position) parts.push(`at character ${err.position}`);
  if (err.detail) parts.push(`detail: ${err.detail}`);
  if (err.hint) parts.push(`hint: ${err.hint}`);
  return parts.join(" | ");
}

export function textResult(payload) {
  return { content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload) }] };
}

export function errorResult(err) {
  return { content: [{ type: "text", text: `Error: ${formatError(err)}` }], isError: true };
}
