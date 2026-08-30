/**
 * What the agent remembers between runs (PRD section 3.3).
 *
 * Three things, in one place because they are one question — decision traces,
 * folder cursors, and learned patterns. A trace explains a decision, a cursor
 * says where to resume, and a pattern is what the traces taught.
 *
 * On `node:sqlite` rather than a driver: Node 22 ships it, this project's whole
 * argument is about what runs on one machine under one operator's control, and
 * a native module that has to compile is a thing that breaks on a server at
 * three in the morning. The API is marked experimental, which is the cost —
 * accepted because the surface used here is `exec`, `prepare`, `run` and
 * `all`, and any replacement offers those.
 */

import { DatabaseSync } from 'node:sqlite';

import type {
  CascadeNode,
  DecisionTrace,
  LearnedPattern,
  RoutingRule,
  TraceStep,
} from '../cascade/types.js';
import { toMailCategory, type MailCategory } from '../types.js';

const SCHEMA = `
create table if not exists traces (
  message_id  text primary key,
  thread_id   text,
  owner_acted integer not null default 0,
  decided_by  text    not null,
  category    text    not null,
  confidence  real    not null,
  rationale   text    not null,
  used_model  integer not null,
  started_at  text    not null,
  duration_ms integer not null,
  steps       text    not null
);
create index if not exists traces_started_at on traces (started_at);
create index if not exists traces_thread on traces (thread_id);

create table if not exists cursors (
  folder     text primary key,
  cursor     text not null,
  updated_at text not null
);

create table if not exists routes (
  key      text primary key,
  list_id  text,
  sender   text,
  category text not null,
  note     text,
  added_at text not null
);

create table if not exists patterns (
  key              text primary key,
  list_id          text,
  sender           text,
  subject_contains text,
  category         text not null,
  confidence       real not null,
  updated_at       text not null
);
`;

/** How often the model ran, which is the KPI PRD section 4.2 is built on. */
export interface Efficiency {
  readonly classified: number;
  readonly withModel: number;
  /** 0 to 1, or `null` when nothing has been classified yet. */
  readonly settledFree: number | null;
}

export class MailStore {
  private readonly db: DatabaseSync;

  /** `:memory:` for a test, a path under `$DSH_HOME` for a deployment. */
  constructor(location: string) {
    this.db = new DatabaseSync(location);
    // Survives a power cut mid-write, which a mail agent running unattended
    // will eventually meet.
    this.db.exec('pragma journal_mode = wal');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /**
   * Brings a database written by an earlier version up to this schema.
   *
   * SQLite has no `add column if not exists`, and a store that refuses to open
   * because it predates a column is a store that loses the history it exists
   * to keep.
   */
  private migrate(): void {
    const columns = this.db
      .prepare('select name from pragma_table_info(?)')
      .all('traces')
      .map((row) => String((row as { name: string }).name));
    if (!columns.includes('thread_id')) {
      this.db.exec('alter table traces add column thread_id text');
      this.db.exec('create index if not exists traces_thread on traces (thread_id)');
    }
    if (!columns.includes('owner_acted')) {
      this.db.exec('alter table traces add column owner_acted integer not null default 0');
    }
  }

  // --- traces ---------------------------------------------------------------

  /**
   * Records one decision, replacing any earlier one for the same message.
   *
   * Replacing rather than appending: a message has one current classification,
   * and a history of re-decisions is a different feature with different
   * retention questions. What is kept is what the agent currently believes.
   */
  /**
   * @param ownerActed whether the owner has replied in this thread. PRD
   * section 4.2 makes node 1 conditional on it, and it is the one signal in
   * the design that reuse cannot inflate: it is a fact about the owner rather
   * than about the classifier.
   */
  recordTrace(trace: DecisionTrace, threadId?: string | null, ownerActed = false): void {
    this.db
      .prepare(
        `insert into traces
           (message_id, thread_id, owner_acted, decided_by, category, confidence, rationale, used_model, started_at, duration_ms, steps)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(message_id) do update set
           thread_id = excluded.thread_id,
           owner_acted = excluded.owner_acted,
           decided_by = excluded.decided_by,
           category = excluded.category,
           confidence = excluded.confidence,
           rationale = excluded.rationale,
           used_model = excluded.used_model,
           started_at = excluded.started_at,
           duration_ms = excluded.duration_ms,
           steps = excluded.steps`,
      )
      .run(
        trace.messageId,
        threadId ?? null,
        ownerActed ? 1 : 0,
        trace.decidedBy,
        trace.category,
        trace.confidence,
        trace.rationale,
        trace.usedModel ? 1 : 0,
        trace.startedAt.toISOString(),
        trace.durationMs,
        JSON.stringify(trace.steps),
      );
  }

  traceFor(messageId: string): DecisionTrace | null {
    const row = this.db.prepare('select * from traces where message_id = ?').get(messageId);
    return row === undefined ? null : toTrace(row);
  }

  /** Most recent first, for the operator view PRD section 4.6 describes. */
  recentTraces(limit = 50): DecisionTrace[] {
    const rows = this.db
      .prepare('select * from traces order by started_at desc limit ?')
      .all(limit);
    return rows.map(toTrace);
  }

  /**
   * How much of what was classified never reached the model.
   *
   * The number the architecture's cost argument rests on, measured from what
   * actually happened rather than projected from a corpus.
   */
  efficiency(since?: Date): Efficiency {
    const row =
      since === undefined
        ? this.db.prepare('select count(*) n, sum(used_model) m from traces').get()
        : this.db
            .prepare('select count(*) n, sum(used_model) m from traces where started_at >= ?')
            .get(since.toISOString());

    const classified = Number((row as { n: number }).n);
    const withModel = Number((row as { m: number | null }).m ?? 0);
    return {
      classified,
      withModel,
      settledFree: classified === 0 ? null : (classified - withModel) / classified,
    };
  }

  /**
   * What this thread was last decided to be, for node 1 (PRD section 4.2).
   *
   * Node 1 is the only node that can settle a message from a person cheaply,
   * and on a mailbox where 70% of the traffic is written by people that makes
   * it the one with the most left to give.
   *
   * Three conditions, and each is a refusal the node needs:
   *
   * - **Not `needs-review`.** Inheriting "I do not know" propagates a
   *   non-answer down a thread and makes it look like a decision.
   * - **At or above a floor.** A thread inherits from a decision, not from a
   *   guess, and node 1 settles at zero cost with no second opinion.
   * - **The most recent.** A thread that changed character — a notification
   *   thread someone replied to — is described by its latest message.
   * - **The owner has acted in it.** PRD section 4.2 says so, and a warm
   *   simulation showed why: without it, node 1 inherits into every thread the
   *   classifier has touched, and a bias the model holds evenly gets amplified
   *   evenly — 61% of a mailbox came back `important`. Whether the owner
   *   replied is a fact about the owner, and the one signal here that reuse
   *   cannot inflate.
   */
  threadCategory(threadId: string | null, minConfidence = 0.85): MailCategory | null {
    if (threadId === null || threadId.length === 0) return null;
    const row = this.db
      .prepare(
        `select category from traces
         where thread_id = ? and category <> 'needs-review' and confidence >= ?
           and exists (select 1 from traces t2 where t2.thread_id = traces.thread_id and t2.owner_acted = 1)
         order by started_at desc limit 1`,
      )
      .get(threadId, minConfidence);
    return row === undefined ? null : toMailCategory(String((row as { category: string }).category));
  }

  /** How many messages of a thread already have a decision. */
  threadSize(threadId: string | null): number {
    if (threadId === null || threadId.length === 0) return 0;
    const row = this.db.prepare('select count(*) n from traces where thread_id = ?').get(threadId);
    return Number((row as { n: number }).n);
  }

  // --- cursors --------------------------------------------------------------

  saveCursor(folder: string, cursor: string): void {
    this.db
      .prepare(
        `insert into cursors (folder, cursor, updated_at) values (?, ?, ?)
         on conflict(folder) do update set cursor = excluded.cursor, updated_at = excluded.updated_at`,
      )
      .run(folder, cursor, new Date().toISOString());
  }

  /** `null` for a folder never polled, which is what `currentCursor` is for. */
  loadCursor(folder: string): string | null {
    const row = this.db.prepare('select cursor from cursors where folder = ?').get(folder);
    return row === undefined ? null : String((row as { cursor: string }).cursor);
  }

  // --- stated routes --------------------------------------------------------

  /**
   * Replaces the stored routes with this set.
   *
   * A different table from `patterns`, and that is the whole point:
   * `savePatterns` deletes its set on every learning pass, and a stated route
   * living there would be destroyed by a routine nobody would think to check
   * before running.
   */
  saveRoutes(routes: readonly RoutingRule[]): void {
    const now = new Date().toISOString();
    this.db.exec('begin');
    try {
      this.db.exec('delete from routes');
      const insert = this.db.prepare(
        'insert or replace into routes (key, list_id, sender, category, note, added_at) values (?, ?, ?, ?, ?, ?)',
      );
      for (const r of routes) {
        insert.run(routeKey(r), r.listId ?? null, r.sender, r.category, r.note ?? null, now);
      }
      this.db.exec('commit');
    } catch (err: unknown) {
      this.db.exec('rollback');
      throw err;
    }
  }

  loadRoutes(): RoutingRule[] {
    const rows = this.db.prepare('select * from routes order by key').all();
    const routes: RoutingRule[] = [];
    for (const raw of rows) {
      const row = raw as {
        list_id: string | null;
        sender: string | null;
        category: string;
        note: string | null;
      };
      const category = toMailCategory(row.category);
      // A route naming a category the vocabulary no longer has is skipped
      // rather than guessed at. Unlike a learned pattern, nothing will replace
      // it: the owner stated it and only the owner can restate it.
      if (category === null) continue;
      routes.push({
        listId: row.list_id,
        sender: row.sender,
        category,
        note: row.note ?? undefined,
      });
    }
    return routes;
  }

  /** How many routes are stored, so a caller can tell seeded from empty. */
  countRoutes(): number {
    const row = this.db.prepare('select count(*) as n from routes').get() as { n: number };
    return row.n;
  }

  /**
   * Writes the seed routes, but only into a store that has none.
   *
   * The profile's list is a seed, not a record. Once the store holds routes,
   * they are the truth and the profile is ignored — otherwise a route the
   * owner removed at runtime would come back on the next restart, and a route
   * they added would be silently outranked by a stale file.
   *
   * Returns what was written, so a caller can say whether it seeded or found.
   */
  seedRoutes(seed: readonly RoutingRule[]): number {
    if (seed.length === 0 || this.countRoutes() > 0) return 0;
    this.saveRoutes(seed);
    return this.countRoutes();
  }

  // --- learned patterns -----------------------------------------------------

  /**
   * Replaces the stored set with this one.
   *
   * Whole-set rather than incremental: `mergePatterns` already decides what
   * survives, and two places deciding that is how a pattern nobody can explain
   * ends up in the table.
   */
  savePatterns(patterns: readonly LearnedPattern[]): void {
    const now = new Date().toISOString();
    this.db.exec('begin');
    try {
      this.db.exec('delete from patterns');
      const insert = this.db.prepare(
        `insert into patterns (key, list_id, sender, subject_contains, category, confidence, updated_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const p of patterns) {
        const key = routeKey(p);
        insert.run(
          key,
          p.listId ?? null,
          p.sender,
          p.subjectContains,
          p.category,
          p.confidence,
          now,
        );
      }
      this.db.exec('commit');
    } catch (err: unknown) {
      this.db.exec('rollback');
      throw err;
    }
  }

  loadPatterns(): LearnedPattern[] {
    const rows = this.db.prepare('select * from patterns order by key').all();
    const patterns: LearnedPattern[] = [];
    for (const raw of rows) {
      const row = raw as {
        list_id: string | null;
        sender: string | null;
        subject_contains: string | null;
        category: string;
        confidence: number;
      };
      const category = toMailCategory(row.category);
      // A row whose category is no longer in the vocabulary is not a pattern
      // to guess at: it is skipped, and the next learning pass replaces it.
      if (category === null) continue;
      patterns.push({
        listId: row.list_id,
        sender: row.sender,
        subjectContains: row.subject_contains,
        category,
        confidence: row.confidence,
      });
    }
    return patterns;
  }

  close(): void {
    this.db.close();
  }
}

function toTrace(raw: unknown): DecisionTrace {
  const row = raw as {
    message_id: string;
    decided_by: string;
    category: string;
    confidence: number;
    rationale: string;
    used_model: number;
    started_at: string;
    duration_ms: number;
    steps: string;
  };
  const category = toMailCategory(row.category);
  if (category === null) throw new TypeError(`stored trace has an unknown category: ${row.category}`);

  return {
    messageId: row.message_id,
    decidedBy: row.decided_by as CascadeNode,
    category,
    confidence: row.confidence,
    rationale: row.rationale,
    usedModel: row.used_model === 1,
    startedAt: new Date(row.started_at),
    durationMs: row.duration_ms,
    steps: JSON.parse(row.steps) as TraceStep[],
  };
}

/**
 * What identifies a source, for either table.
 *
 * Shared so a stated route and a learned pattern for the same sender cannot
 * disagree about what they are keyed on — which would let both exist and only
 * one be found.
 */
function routeKey(rule: { readonly listId?: string | null | undefined; readonly sender: string | null }): string {
  return rule.listId !== null && rule.listId !== undefined
    ? `list:${rule.listId.toLowerCase()}`
    : `from:${(rule.sender ?? '').toLowerCase()}`;
}
