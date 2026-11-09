// Build with npm run build. SQLite provides queue admission and owner exclusion.
import { DatabaseSync } from 'node:sqlite';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentConfig } from './config.js';
import type { AgentEvent, PollState } from './github.js';

export interface Job { id: string; agentId: string; event: AgentEvent; status: string; conversationId?: number; submissionId?: number; error?: string; result?: string }
export class Catalog {
  private constructor(readonly directory: string, private owner: DatabaseSync, private db: DatabaseSync) {}
  static async open(directory: string, agents: AgentConfig[]) {
    await mkdir(directory, { recursive: true }); directory = await realpath(directory);
    const owner = new DatabaseSync(join(directory, 'owner.sqlite'));
    let db: DatabaseSync | undefined;
    try {
      owner.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
      db = new DatabaseSync(join(directory, 'catalog.sqlite'));
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, active INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, agentId TEXT NOT NULL REFERENCES agents(id), event TEXT NOT NULL, status TEXT NOT NULL, conversationId INTEGER, submissionId INTEGER, error TEXT, result TEXT);
        CREATE TABLE IF NOT EXISTS poll_states (repository TEXT PRIMARY KEY, state TEXT NOT NULL);`);
      const catalog = new Catalog(directory, owner, db);
      catalog.atomic(() => {
        db!.exec('UPDATE agents SET active=0');
        for (const a of agents) db!.prepare('INSERT INTO agents VALUES (?,?,1) ON CONFLICT(id) DO UPDATE SET name=excluded.name,active=1').run(a.id,a.name);
        db!.exec("UPDATE jobs SET status='queued' WHERE status='running'");
      });
      return catalog;
    } catch (error) { db?.close(); owner.close(); throw new Error('Cannot acquire/open service state; another owner may already be running.', { cause: error }); }
  }
  private atomic<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = operation(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  admit(events: AgentEvent[], agents: AgentConfig[], poll?: { repository: string; state: PollState }): string[] {
    return this.atomic(() => {
      const ids: string[] = [];
      for (const event of events) {
        this.db.prepare('INSERT OR IGNORE INTO events VALUES (?,?)').run(event.id,JSON.stringify(event));
        for (const agent of agents.filter(a => a.repositories.includes(event.repository.toLowerCase()))) {
          const id = `${event.id}:${agent.id}`;
          const changed = this.db.prepare("INSERT OR IGNORE INTO jobs(id,agentId,event,status) VALUES (?,?,?,'queued')").run(id,agent.id,JSON.stringify(event));
          if (changed.changes) ids.push(id);
        }
      }
      if (poll) this.db.prepare('INSERT INTO poll_states VALUES (?,?) ON CONFLICT(repository) DO UPDATE SET state=excluded.state').run(poll.repository,JSON.stringify(poll.state));
      return ids;
    });
  }
  state(repository: string): PollState { const row = this.db.prepare('SELECT state FROM poll_states WHERE repository=?').get(repository); return row ? JSON.parse(String(row.state)) : { initialized:false,seen:[] }; }
  agents() { return this.db.prepare("SELECT a.id,a.name,a.active,(SELECT COUNT(*) FROM jobs j WHERE j.agentId=a.id AND j.status IN ('queued','running')) AS pending FROM agents a ORDER BY a.id").all(); }
  jobs(agentId: string): Job[] { return this.db.prepare('SELECT * FROM jobs WHERE agentId=? ORDER BY rowid DESC LIMIT 100').all(agentId).map(r => ({...r,event:JSON.parse(String(r.event))}) as unknown as Job); }
  job(agentId:string,id:string):Job|undefined {const row=this.db.prepare('SELECT * FROM jobs WHERE agentId=? AND id=?').get(agentId,id);return row?{...row,event:JSON.parse(String(row.event))} as unknown as Job:undefined;}
  counts(agentId:string):Record<string,number>{return Object.fromEntries(this.db.prepare('SELECT status,COUNT(*) AS count FROM jobs WHERE agentId=? GROUP BY status').all(agentId).map(row=>[String(row.status),Number(row.count)]));}
  next(agentId: string): Job | undefined { const row = this.db.prepare("SELECT * FROM jobs WHERE agentId=? AND status='queued' ORDER BY rowid LIMIT 1").get(agentId); return row ? {...row,event:JSON.parse(String(row.event))} as unknown as Job : undefined; }
  update(id: string, status: string, fields: {conversationId?:number;submissionId?:number;error?:string;result?:string} = {}) {
    this.db.prepare('UPDATE jobs SET status=?,conversationId=COALESCE(?,conversationId),submissionId=COALESCE(?,submissionId),error=?,result=? WHERE id=?').run(status,fields.conversationId ?? null,fields.submissionId ?? null,fields.error ?? null,fields.result ?? null,id);
  }
  close() { this.db.close(); this.owner.close(); }
}
