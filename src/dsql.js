import pg from 'pg';
import { DsqlSigner } from '@aws-sdk/dsql-signer';
import { fromIni } from '@aws-sdk/credential-providers';

// Aurora DSQL speaks the PostgreSQL wire protocol, exposes a single "postgres"
// database, and authenticates with a short-lived IAM token instead of a password.
const DATABASE = 'postgres';
const PORT = 5432;
const SYSTEM_SCHEMAS = ['pg_catalog', 'information_schema', 'pg_toast'];
const READ_STATEMENTS = /^(select|with|table|values|show)\b/i;
// Aurora DSQL does not support foreign key constraints, so an ER diagram has to
// fall back on naming conventions. These describe the shape of a reference —
// “owner_id”, “fk_tenant”, “accountUuid” — and which types can be compared.
const KEY_COLUMN = /^(?:fk_)?(.+?)_?(?:id|ids|uuid|guid|key|fk|ref)$/i;
const TYPE_FAMILIES = [['smallint', 'integer', 'bigint'], ['character varying', 'character', 'text', 'citext', 'name'],
  ['numeric', 'decimal', 'real', 'double precision'], ['timestamp without time zone', 'timestamp with time zone', 'date'], ['json', 'jsonb']];
const SELF_REFERENCE_WORDS = ['parent', 'child', 'previous', 'next', 'successor', 'predecessor'];
// Write statements only ever start a statement: at the beginning of the input,
// after a semicolon, or inside a data-modifying CTE — “WITH x AS (INSERT …)”.
// Anchoring on that context keeps ordinary columns named “comment” or “set” usable.
const WRITE_STATEMENTS = /(?:^|[(;])\s*(insert|update|delete|merge|truncate|drop|create|alter|grant|revoke|copy|call|do|vacuum|reindex|refresh|lock|cluster|comment|analyze|prepare|execute|deallocate|declare|fetch|move|close|listen|notify|unlisten|discard|reassign|reset|set|begin|start|commit|rollback|savepoint|import)\b/i;

export class DsqlReader {
  constructor({ profile, user } = {}) { this.profile = profile; this.user = user || 'admin'; }

  async connect({ host, region }) {
    const signer = new DsqlSigner({ hostname: host, region, ...(this.profile ? { credentials: fromIni({ profile: this.profile }) } : {}) });
    const password = this.user === 'admin' ? await signer.getDbConnectAdminAuthToken() : await signer.getDbConnectAuthToken();
    const client = new pg.Client({ host, port: PORT, database: DATABASE, user: this.user, password, ssl: { rejectUnauthorized: true },
      application_name: 'stackeye', connectionTimeoutMillis: 15000, query_timeout: 30000 });
    await client.connect();
    return client;
  }

  async schema(target) {
    const client = await this.connect(target);
    try {
      const version = (await client.query('SELECT version() AS version')).rows[0]?.version || '';
      const columns = await client.query(`SELECT table_schema, table_name, column_name, data_type, is_nullable
        FROM information_schema.columns WHERE table_schema <> ALL($1::text[])
        ORDER BY table_schema, table_name, ordinal_position`, [SYSTEM_SCHEMAS]);
      const keys = await client.query(`SELECT n.nspname AS table_schema, c.relname AS table_name, a.attname AS column_name,
          i.indisprimary AS is_primary, i.indnatts AS index_columns
        FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
        WHERE i.indisunique AND n.nspname <> ALL($1::text[])`, [SYSTEM_SCHEMAS]);
      const relations = await client.query(`SELECT table_schema, table_name, table_type
        FROM information_schema.tables WHERE table_schema <> ALL($1::text[])`, [SYSTEM_SCHEMAS]);
      const qualified = (r) => `${r.table_schema}.${r.table_name}.${r.column_name}`;
      const primaryKeys = new Set(keys.rows.filter((r) => r.is_primary).map(qualified));
      const uniqueColumns = new Set(keys.rows.filter((r) => Number(r.index_columns) === 1).map(qualified));
      const views = new Set(relations.rows.filter((r) => r.table_type !== 'BASE TABLE').map((r) => `${r.table_schema}.${r.table_name}`));
      const tables = new Map();
      for (const row of columns.rows) {
        const key = `${row.table_schema}.${row.table_name}`;
        if (!tables.has(key)) tables.set(key, { schema: row.table_schema, name: row.table_name, kind: views.has(key) ? 'view' : 'table', columns: [] });
        tables.get(key).columns.push({ name: row.column_name, type: row.data_type, nullable: row.is_nullable === 'YES',
          primaryKey: primaryKeys.has(`${key}.${row.column_name}`), unique: uniqueColumns.has(`${key}.${row.column_name}`) });
      }
      const list = [...tables.values()];
      const declared = await readForeignKeys(client);
      const relationships = [...declared, ...inferRelationships(list, declared)].map((relationship) => describeRelationship(relationship, list));
      return { database: DATABASE, user: this.user, version, tables: list, relationships };
    } finally { await client.end().catch(() => {}); }
  }

  async query(target, { sql, limit }) {
    const statement = readOnlyStatement(sql);
    const cap = clampRows(limit);
    const client = await this.connect(target);
    const started = process.hrtime.bigint();
    try {
      const readOnlyTransaction = await beginReadOnly(client);
      const result = await client.query({ text: statement, rowMode: 'array' });
      const returned = result.rows?.length || 0;
      return { fields: await describeFields(client, result.fields), rows: (result.rows || []).slice(0, cap),
        returned, truncated: returned > cap, limit: cap, command: result.command, readOnlyTransaction,
        durationMs: Math.round(Number(process.hrtime.bigint() - started) / 1e5) / 10 };
    } finally {
      // Roll back unconditionally: nothing this editor runs is meant to persist.
      await client.query('ROLLBACK').catch(() => {});
      await client.end().catch(() => {});
    }
  }
}

// Declared foreign keys are read opportunistically: a cluster that rejects the
// catalog query, or one that simply cannot hold such constraints, still gets an
// ER diagram built from the inferred references below.
async function readForeignKeys(client) {
  let rows = [];
  try {
    rows = (await client.query(`SELECT con.conname AS name, k.ord AS ord,
        sn.nspname AS source_schema, sc.relname AS source_table, sa.attname AS source_column,
        tn.nspname AS target_schema, tc.relname AS target_table, ta.attname AS target_column
      FROM pg_constraint con
      JOIN pg_class sc ON sc.oid = con.conrelid JOIN pg_namespace sn ON sn.oid = sc.relnamespace
      JOIN pg_class tc ON tc.oid = con.confrelid JOIN pg_namespace tn ON tn.oid = tc.relnamespace
      JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(source_attnum, target_attnum, ord) ON true
      JOIN pg_attribute sa ON sa.attrelid = con.conrelid AND sa.attnum = k.source_attnum
      JOIN pg_attribute ta ON ta.attrelid = con.confrelid AND ta.attnum = k.target_attnum
      WHERE con.contype = 'f' AND sn.nspname <> ALL($1::text[])
      ORDER BY con.conname, k.ord`, [SYSTEM_SCHEMAS])).rows;
  } catch { return []; }
  const constraints = new Map();
  for (const row of rows) {
    const key = `${row.source_schema}.${row.source_table}.${row.name}`;
    if (!constraints.has(key)) constraints.set(key, { id: key, name: row.name, source: `${row.source_schema}.${row.source_table}`,
      target: `${row.target_schema}.${row.target_table}`, columns: [], declared: true, confidence: 'declared' });
    constraints.get(key).columns.push({ from: row.source_column, to: row.target_column });
  }
  return [...constraints.values()];
}

// Every reference a naming convention can justify: a column whose name points at
// another table (“order_id” → orders) or repeats that table's own primary-key
// name (“tenant_id” in both). Ambiguous and type-mismatched guesses are dropped
// rather than drawn, because a wrong edge is worse than a missing one.
export function inferRelationships(tables, declared = []) {
  const claimed = new Set(declared.flatMap((relationship) => relationship.columns.map((column) => `${relationship.source}.${column.from}`)));
  const candidates = tables.filter((table) => table.kind !== 'view').map((table) => ({ table, key: singlePrimaryKey(table) })).filter((candidate) => candidate.key);
  const found = [];
  for (const table of tables) {
    for (const column of table.columns) {
      if (claimed.has(`${tableId(table)}.${column.name}`)) continue;
      const match = bestReference(candidates, table, column);
      if (!match) continue;
      found.push({ id: `${tableId(table)}.${column.name}->${tableId(match.table)}`, name: `${table.name}.${column.name}`,
        source: tableId(table), target: tableId(match.table), columns: [{ from: column.name, to: match.key.name }], declared: false, confidence: match.confidence });
    }
  }
  return found;
}

function bestReference(candidates, table, column) {
  const base = KEY_COLUMN.exec(column.name)?.[1];
  if (!base) return null;
  const scored = [];
  for (const candidate of candidates) {
    if (candidate.table === table && candidate.key.name === column.name) continue;
    if (!comparableTypes(column.type, candidate.key.type)) continue;
    const bonus = candidate.table.schema === table.schema ? 1 : 0;
    if (sameEntityName(base, candidate.table.name)) scored.push({ ...candidate, confidence: 'high', score: 6 + bonus });
    else if (candidate.table === table && SELF_REFERENCE_WORDS.includes(base.toLowerCase())) scored.push({ ...candidate, confidence: 'medium', score: 4 });
    else if (column.name.toLowerCase() === candidate.key.name.toLowerCase() && !sameEntityName(base, table.name)) scored.push({ ...candidate, confidence: 'medium', score: 2 + bonus });
  }
  const best = scored.sort((a, b) => b.score - a.score)[0];
  if (!best || scored.filter((entry) => entry.score === best.score).length > 1) return null;
  return best;
}

// Cardinality reads off the referencing side: a unique column can only point at
// one row, anything else can repeat, and a nullable column makes the link optional.
function describeRelationship(relationship, tables) {
  const source = tables.find((table) => tableId(table) === relationship.source);
  const columns = relationship.columns.map((column) => source?.columns.find((candidate) => candidate.name === column.from)).filter(Boolean);
  const unique = columns.length > 0 && columns.every((column) => column.unique);
  return { ...relationship, unique, optional: columns.some((column) => column.nullable), cardinality: unique ? 'one-to-one' : 'many-to-one' };
}

function tableId(table) { return `${table.schema}.${table.name}`; }
function singlePrimaryKey(table) { const keys = table.columns.filter((column) => column.primaryKey); return keys.length === 1 ? keys[0] : null; }
function comparableTypes(a, b) { return a === b || TYPE_FAMILIES.some((family) => family.includes(a) && family.includes(b)); }
function sameEntityName(a, b) { const forms = nameForms(b); return [...nameForms(a)].some((form) => forms.has(form)); }

// English pluralisation is too irregular to singularise reliably in one pass —
// warehouses, statuses, and boxes all want a different rule — so every plausible
// singular is kept and two names match when any of their forms agree.
function nameForms(name) {
  const plain = String(name).replace(/[^a-z0-9]+/gi, '').toLowerCase(), forms = new Set([plain]);
  if (plain.length > 3 && plain.endsWith('ies')) forms.add(`${plain.slice(0, -3)}y`);
  if (plain.length > 3 && plain.endsWith('es')) forms.add(plain.slice(0, -2));
  if (plain.length > 2 && plain.endsWith('s') && !plain.endsWith('ss')) forms.add(plain.slice(0, -1));
  return forms;
}

// The read-only transaction below is the real guarantee. This check exists so a
// mistyped write fails with a clear message instead of a Postgres error, and so
// batches can never smuggle a second statement past the editor.
export function readOnlyStatement(sql) {
  const statements = blankLiterals(String(sql || '')).split(';').map((s) => s.trim()).filter(Boolean);
  if (!statements.length) throw new Error('Enter a SQL query to run');
  if (statements.length > 1) throw new Error('Run one statement at a time — the read-only editor does not execute batches');
  const body = statements[0].replace(/^explain\s+(?:(?:\([^)]*\)|analyze|verbose)\s+)*/i, '');
  if (!READ_STATEMENTS.test(body)) throw new Error(`“${body.split(/\s+/)[0].toUpperCase()}” is not a read-only statement. Use SELECT, WITH, TABLE, VALUES, SHOW, or EXPLAIN.`);
  const write = body.match(WRITE_STATEMENTS);
  if (write) throw new Error(`“${write[1].toUpperCase()}” is not allowed in the read-only editor`);
  return String(sql).trim().replace(/;\s*$/, '');
}

// Replaces comments, string literals, and quoted identifiers with spaces so
// keyword and statement-separator scanning never inspects user data. Lengths are
// preserved so the blanked copy stays aligned with the original statement.
function blankLiterals(sql) {
  let out = '', i = 0;
  const blank = (end) => { out += ' '.repeat(end - i); i = end; };
  while (i < sql.length) {
    const pair = sql.slice(i, i + 2);
    if (pair === '--') { const end = sql.indexOf('\n', i); blank(end === -1 ? sql.length : end); continue; }
    if (pair === '/*') {
      let depth = 1, j = i + 2;
      while (j < sql.length && depth) {
        if (sql.slice(j, j + 2) === '/*') { depth++; j += 2; }
        else if (sql.slice(j, j + 2) === '*/') { depth--; j += 2; }
        else j++;
      }
      blank(j); continue;
    }
    const dollarTag = /^\$([A-Za-z_]\w*)?\$/.exec(sql.slice(i));
    if (dollarTag) { const end = sql.indexOf(dollarTag[0], i + dollarTag[0].length); blank(end === -1 ? sql.length : end + dollarTag[0].length); continue; }
    const quote = sql[i];
    if (quote === "'" || quote === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] !== quote) j++;
        else if (sql[j + 1] === quote) j += 2;
        else { j++; break; }
      }
      blank(j); continue;
    }
    out += sql[i]; i++;
  }
  return out;
}

async function beginReadOnly(client) {
  for (const commands of [['BEGIN READ ONLY'], ['BEGIN', 'SET TRANSACTION READ ONLY']]) {
    try { for (const command of commands) await client.query(command); return true; }
    catch { await client.query('ROLLBACK').catch(() => {}); }
  }
  return false;
}

async function describeFields(client, fields = []) {
  const oids = [...new Set(fields.map((f) => f.dataTypeID))];
  let names = new Map();
  if (oids.length) {
    try { names = new Map((await client.query('SELECT oid, typname FROM pg_type WHERE oid = ANY($1::oid[])', [oids])).rows.map((r) => [Number(r.oid), r.typname])); }
    catch { /* type names are cosmetic; fall back to the OID */ }
  }
  return fields.map((f) => ({ name: f.name, type: names.get(f.dataTypeID) || String(f.dataTypeID) }));
}

function clampRows(value) { return Math.min(Math.max(Number(value) || 200, 1), 1000); }
