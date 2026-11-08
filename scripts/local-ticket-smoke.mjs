#!/usr/bin/env node
/** Local ticket acceptance. No imports from the plugin: importing Store would migrate/write its database. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SMOKE_ROOT = '/Volumes/Macssd/工单/20261103-local-ticket-smoke';
const sha = value => createHash('sha256').update(value).digest('hex');
const key = (...values) => sha(JSON.stringify(values)).slice(0, 32);
const text = message => (message?.content ?? []).filter(p => p.type === 'text').map(p => p.text).join('');
const need = (ok, reason) => { if (!ok) throw new Error(reason); };
const one = (items, label) => { need(items.length === 1, `${label}: expected 1, got ${items.length}`); return items[0]; };

export function plan(runId, sessionId) {
  need(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(runId ?? ''), 'run-id must be 1–64 ASCII letters/digits/_/-');
  need(typeof sessionId === 'string' && /^orchestrator-[A-Za-z0-9_-]+$/.test(sessionId), 'explicit main --session required');
  const requestId = `local-ticket-smoke:${runId}`;
  const directory = join(SMOKE_ROOT, runId), path = join(directory, 'receipt.txt');
  const content = `LOCAL_TICKET_SMOKE_RECEIPT\nrun=${runId}\nrequest=${requestId}\n`;
  const prompt = [
    `真实通用工单验收，标识 ${requestId}。请新建独立 general 工单，directory 必须精确为 ${directory}。`,
    '不要走闲聊，不要把本请求并入旧工单。仅允许创建上述专用目录及 receipt.txt；不得改任何其他文件、设置、凭据或服务，不得调用 fleet 或子 Agent。',
    `receipt.txt 必须是 UTF-8，逐字写入以下 JSON 字符串解码后的内容：${JSON.stringify(content)}。`,
    `worker 写完后须读回文件并计算 SHA-256，必须等于 ${sha(content)}。`,
    `然后调用 orchestrator_report，state=ready，summary 必须是这一行（将 <ticketId> 换为真实工单 ID）：LOCAL_TICKET_SMOKE_OK run=${runId} ticket=<ticketId> path=${path} sha256=${sha(content)}`,
    '主 Session 等待 outbox 的原文回投，再在该轮最终回答原样展示这一行且只展示一次；不要另发 orchestrator_reply，不要把“收到”或 idle 当完成。',
  ].join('\n');
  return { runId, sessionId, requestId, directory, path, content, sha256: sha(content),
    request: { sessionId, requestId, mode: 'queue', content: [{ type: 'text', text: prompt }], clientTimeZone: 'Asia/Shanghai' } };
}

/** Accept raw records, never caller-supplied success booleans. Fixtures use this exact live checker. */
export function checkSnapshot(snapshot) {
  const p = plan(snapshot.runId, snapshot.sessionId);
  const { triggers = [], tickets = [], outbox = [], effects = [], mainEvents = [], workerEvents = [] } = snapshot;
  const input = one(mainEvents.filter(e => e.type === 'user/message' && e.data?.source?.kind === 'user'
    && e.data.source.rpcId === p.requestId), 'original main user message');
  need(text(input.data) === text(p.request), 'input differs from the fixed smoke request');
  const trigger = one(triggers, 'local trigger');
  need(trigger.source === 'local' && trigger.human === true && trigger.meta?.agentId === p.sessionId
    && trigger.meta?.messageId === input.data.id && trigger.text === text(p.request)
    && trigger.id === key('local', p.sessionId, input.data.id), 'trigger provenance mismatch');
  const ticket = one(tickets, 'ticket');
  need(ticket.origin?.triggerId === trigger.id && ticket.mandate?.kind === 'general'
    && ticket.mandate.directory === p.directory && ticket.execution?.directory === p.directory, 'general ticket origin/directory mismatch');
  need(ticket.ended?.outcome === 'completed' && ticket.ended.by === 'executor' && !ticket.delivery
    && !ticket.attention && ticket.undelivered?.length === 0, 'ticket is not completed cleanly');
  const assignment = one(ticket.assignments ?? [], 'worker assignment');
  need(assignment.startedAt && assignment.state === 'ended' && assignment.report?.state === 'ready', 'worker has no completed ready report');
  const summary = `LOCAL_TICKET_SMOKE_OK run=${p.runId} ticket=${ticket.id} path=${p.path} sha256=${p.sha256}`;
  need(assignment.report.summary === summary, 'worker summary does not match receipt identity and hash');
  need(snapshot.receipt?.path === p.path && snapshot.receipt?.content === p.content
    && snapshot.receipt?.regular === true && snapshot.receipt?.canonical === true
    && JSON.stringify(snapshot.receipt.entries) === JSON.stringify(['receipt.txt']), 'receipt missing, wrong, symlinked, or directory contains extra files');
  need(snapshot.workerSessionId === `worker-${ticket.id}`, 'wrong worker Session');
  const reportCall = one(workerEvents.filter(e => e.type === 'tool/call' && e.data?.name === 'orchestrator_report'
    && parseArgs(e.data.arguments)?.state === 'ready'), 'worker ready tool call');
  need(parseArgs(reportCall.data.arguments)?.summary === summary, 'worker tool call has a different report');
  const reportResult = one(workerEvents.filter(e => e.type === 'tool/result'
    && e.data?.message?.toolCallId === reportCall.data.callId), 'worker report tool result');
  need(!reportResult.data.message.isError, 'worker report tool failed');
  const result = parseArgs(text(reportResult.data.message));
  const reply = one(outbox.filter(r => r.kind === 'reply'), 'outbox result reply');
  need(reply.workerReport === true && reply.ticketId === ticket.id && reply.status === 'sent'
    && !reply.dropped && reply.text === summary && reply.channel?.source === 'local'
    && reply.channel.thread === `local:${p.sessionId}` && reply.channel.address?.agentId === p.sessionId
    && reply.id === key('worker-report', ticket.id, assignment.report.at, summary), 'outbox report is not sent verbatim to this Session');
  need(result?.reported === true && !result.delivery_error && result.reply?.id === reply.id
    && ['pending', 'sent'].includes(result.reply.status), 'worker tool did not record this report receipt');
  need(!effects.some(e => e.kind === 'reply' && outbox.some(r => r.id === e.key)), 'outbox retry still pending');
  need(outbox.every(r => r.status === 'sent'), 'another ticket outbox message is not sent');
  const deliveryId = `dsh-superagent:${key(`local:${reply.id}`)}`;
  const deliveries = mainEvents.filter(e => e.type === 'user/message' && e.data?.source?.kind === 'dsh-superagent'
    && (e.data.id === deliveryId || text(e.data) === summary));
  const delivery = one(deliveries, 'main outbox delivery');
  need(delivery.data.id === deliveryId && text(delivery.data) === summary && delivery.seq > input.seq, 'main relay identity/order mismatch');
  // The metadata-only worker_report relay is not an outbox delivery or the user-visible final answer.
  const finals = mainEvents.filter(e => e.type === 'assistant/message' && e.seq > delivery.seq
    && text(e.data?.message).includes(`LOCAL_TICKET_SMOKE_OK run=${p.runId} `));
  const final = one(finals, 'main final answer');
  need(text(final.data.message) === summary, 'main final answer rewrote the worker report');
  need(mainEvents.some(e => e.type === 'turn/end' && e.seq > final.seq && e.data?.turn === final.data.turn
    && e.data.reason?.kind === 'completed'), 'main final turn did not complete');
  need(workerEvents.some(e => e.type === 'turn/end' && e.seq > reportResult.seq && e.data?.turn === reportCall.data.turn
    && e.data.reason?.kind === 'completed'), 'worker report turn did not complete');
  return { runId: p.runId, requestId: p.requestId, mainSessionId: p.sessionId, triggerId: trigger.id,
    ticketId: ticket.id, workerSessionId: snapshot.workerSessionId, assignmentId: assignment.id,
    outboxId: reply.id, deliveryId, deliverySeq: delivery.seq, finalMessageId: final.data.message.id,
    finalSeq: final.seq, receiptPath: p.path, receiptSha256: p.sha256,
    receiptMtimeMs: snapshot.receipt.mtimeMs, counts: { triggers: triggers.length, tickets: tickets.length,
      assignments: ticket.assignments.length, replies: outbox.filter(r => r.kind === 'reply').length,
      deliveries: deliveries.length, finals: finals.length } };
}
function parseArgs(value) { try { return JSON.parse(value); } catch { return undefined; } }

function canonical(path) {
  if (existsSync(path)) return realpathSync(path);
  need(!lstatSync(path, { throwIfNoEntry: false }), 'dangling symlink in smoke path');
  const parent = dirname(path);
  need(parent !== path, 'cannot resolve smoke path');
  return join(canonical(parent), path.slice(parent.length + (parent === sep ? 0 : 1)));
}
function readReceipt(p) {
  const st = lstatSync(p.path, { throwIfNoEntry: false });
  if (!st) return null;
  need(st.size <= 4096, 'receipt is too large');
  return { path: p.path, regular: st.isFile(), canonical: canonical(p.path) === p.path,
    entries: readdirSync(p.directory).sort(), mtimeMs: st.mtimeMs,
    content: st.isFile() && !st.isSymbolicLink() ? readFileSync(p.path, 'utf8') : null };
}

function connection(base) {
  const url = new URL(base);
  need(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)
    && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash, 'base must be a loopback HTTP origin, without credentials');
  const headers = { 'content-type': 'application/json', origin: url.origin, 'x-orchestrator-request': '1' };
  const deadline = AbortSignal.timeout(60000);
  // Supplied by the operator's existing authenticated context, never read from credential files or printed.
  if (process.env.DSH_SMOKE_AUTHORIZATION) headers.authorization = process.env.DSH_SMOKE_AUTHORIZATION;
  async function request(path, body) {
    const response = await fetch(new URL(path, url), { method: body ? 'POST' : 'GET', headers,
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error',
      signal: AbortSignal.any([deadline, AbortSignal.timeout(10000)]) });
    need(response.ok, `API HTTP ${response.status} at ${path}; no automatic retry`);
    return response.json();
  }
  return { get: path => request(`/orchestrator/api/${path}`),
    async rpc(method, value) {
      need(['prompt', 'projections', 'page'].includes(method), 'unsupported Session operation');
      const rpcId = randomUUID();
      const response = await request(`/api/session/${method}`, { type: 'client-request', rpcId,
        method: `session/${method}`, payload: { args: { request: value } } });
      need(response.type === 'server-response' && response.rpcId === rpcId, 'invalid RPC response envelope');
      need(response.result?.ok === true, `Session ${method} refused: ${response.result?.error?.code ?? 'unknown'}; no automatic retry`);
      return response.result.value;
    } };
}
async function discover(api) {
  const [state, settings] = await Promise.all([api.get('state'), api.get('settings')]);
  return { masterId: state.masterId, stateDir: state.setup?.machine?.stateDir,
    paused: state.paused, setupProblem: Boolean(state.setup?.problem), localHealth: state.health?.local?.state,
    localEnabled: settings.sources?.find(s => s.id === 'local')?.value?.enabled,
    generalRoots: settings.blocks?.executor?.value?.generalRoots,
    fleetEnabled: settings.blocks?.executor?.value?.fleet?.enabled };
}
async function events(api, sessionId) {
  const projection = await api.rpc('projections', { sessionId });
  need(projection?.kind === 'sequenced' && Number.isInteger(projection.asOfSeq), 'missing exact Session history cursor');
  const throughSeq = projection.asOfSeq;
  const all = [];
  let beforeSeq;
  for (let pages = 0; pages < 100; pages++) {
    const page = await api.rpc('page', { address: { kind: 'session', sessionId }, throughSeq, maxMessages: 200,
      ...(beforeSeq === undefined ? {} : { beforeSeq }) });
    need(Array.isArray(page.records), 'invalid Session page');
    const batch = page.records.map(r => { need(r.type === 'event', 'unknown history record'); return r.event; });
    all.unshift(...batch);
    need(all.length <= 20000, 'history exceeds bounded inspection budget');
    if (!page.hasMore) {
      need(new Set(all.map(e => e.seq)).size === all.length, 'overlapping history pages');
      return all;
    }
    need(batch.length && (beforeSeq === undefined || batch[0].seq < beforeSeq), 'history cursor made no progress');
    beforeSeq = batch[0].seq;
  }
  throw new Error('history page limit reached');
}
async function records(info, p) {
  need(typeof info.stateDir === 'string', 'state API has no database directory');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(info.stateDir, 'orchestrator.sqlite'), { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; BEGIN');
    const decode = rows => rows.map(r => JSON.parse(r.value));
    const triggers = decode(db.prepare("SELECT value FROM trigger WHERE value ->> '$.source' = 'local' AND value ->> '$.meta.agentId' = ? AND instr(value ->> '$.text', ?) > 0").all(p.sessionId, `${p.requestId}。`));
    const ids = triggers.map(t => t.id);
    const tickets = ids.length ? decode(db.prepare(`SELECT DISTINCT ticket.value FROM ticket, json_each(ticket.value, '$.inputs') i
      WHERE ticket.value ->> '$.origin.triggerId' IN (${ids.map(() => '?').join(',')})
      OR i.value ->> '$.triggerId' IN (${ids.map(() => '?').join(',')})`).all(...ids, ...ids)) : [];
    const outbox = tickets.flatMap(t => decode(db.prepare("SELECT value FROM outbox WHERE value ->> '$.ticketId' = ? ORDER BY rowid").all(t.id)));
    const effects = outbox.flatMap(r => db.prepare("SELECT kind, key, attempts, due FROM effect WHERE kind = 'reply' AND key = ?").all(r.id));
    const thread = decode(db.prepare('SELECT value FROM thread WHERE key = ?').all(`local:${p.sessionId}`))[0];
    const subscribed = (thread?.subscriptions ?? []).flatMap(id => decode(db.prepare('SELECT value FROM ticket WHERE id = ?').all(id)));
    // Local uses one thread per main Session. Even completed tickets may resume on a new human message.
    const fanoutTicketIds = subscribed.filter(t => !t.ended || (t.ended.by !== 'human'
      && !thread?.context?.includes(t.id))).map(t => t.id);
    return { triggers, tickets, outbox, effects, fanoutTicketIds };
  } finally { db.close(); }
}
async function snapshot(api, info, p) {
  const data = await records(info, p);
  const workerSessionId = data.tickets.length === 1 ? `worker-${data.tickets[0].id}` : null;
  const [mainEvents, workerEvents] = await Promise.all([events(api, p.sessionId), workerSessionId ? events(api, workerSessionId) : []]);
  return { ...data, runId: p.runId, sessionId: p.sessionId, workerSessionId, mainEvents, workerEvents, receipt: readReceipt(p) };
}
function preflight(info, p) {
  need(info.masterId === p.sessionId, 'session differs from live masterId');
  need(info.localEnabled === true && info.localHealth === 'ready' && !info.paused && !info.setupProblem, 'local intake is not ready');
  need(canonical(p.directory) === p.directory, 'smoke directory aliases/symlinks are not permitted');
  need(info.generalRoots?.some(root => { const rel = relative(canonical(root), p.directory);
    return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep)); }), 'smoke directory is outside generalRoots');
}

const HELP = `Local ticket smoke (Node 22.19+/24+, no dependencies)
  node scripts/local-ticket-smoke.mjs --help
  node scripts/local-ticket-smoke.mjs discover --base http://127.0.0.1:PORT
  node scripts/local-ticket-smoke.mjs run --session ID --run-id UNIQUE [--base URL] [--execute]
  node scripts/local-ticket-smoke.mjs inspect --base URL --session ID --run-id UNIQUE
  node scripts/local-ticket-smoke.mjs replay --base URL --session ID --run-id UNIQUE --execute
  node scripts/local-ticket-smoke.mjs inspect --fixture /absolute/offline-snapshot.json

No arguments: help. discover/inspect: read-only; Session history uses read-only POST RPCs.
run without --execute: prints fixed prompt/request only; no network or file writes.
Only run/replay with --execute may POST session/prompt (starts real work on run).
run refuses an existing directory/request. replay requires a complete successful inspection,
resends the SAME business requestId, observes for 2 seconds, and rejects changed evidence.
Fixed target: ${SMOKE_ROOT}/<run-id>/receipt.txt
No automatic retry, install, settings mutation, worker spawn, or file output.
An API timeout means UNKNOWN; inspect before considering any replay.
DSH_SMOKE_AUTHORIZATION may supply an existing authorization header; never printed.
Network budget: 10 seconds per request, 60 seconds total per invocation.
Exit: 0 operation/check passed, 1 rejected/missing/incomplete/invalid CLI/error.
Fixture passes are OFFLINE_ONLY and never count as production acceptance.
See docs/009-local-acceptance.md for scope, curl/SDK, fleet and recovery instructions.`;

export async function main(argv) {
  if (!argv.length || (argv.length === 1 && argv[0] === '--help')) { console.log(HELP); return; }
  const [mode, ...args] = argv;
  need(['discover', 'inspect', 'run', 'replay'].includes(mode), 'unknown command (use --help)');
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    need(['--base', '--session', '--run-id', '--fixture', '--execute'].includes(name) && !(name in options), 'unknown or duplicate option');
    if (name === '--execute') options[name] = true;
    else { need(args[i + 1] && !args[i + 1].startsWith('--'), `missing ${name} value`); options[name] = args[++i]; }
  }
  need(!options['--execute'] || ['run', 'replay'].includes(mode), '--execute is only valid for run/replay');
  const emit = value => console.log(JSON.stringify(value, null, 2));
  if (options['--fixture']) {
    need(mode === 'inspect' && Object.keys(options).length === 1, '--fixture only accepts inspect; cannot connect or execute');
    const result = checkSnapshot(JSON.parse(readFileSync(options['--fixture'], 'utf8')));
    emit({ status: 'OFFLINE_ONLY_CHECK_PASS', evidence: result, productionAccepted: false }); return;
  }
  const p = mode === 'discover' ? undefined : plan(options['--run-id'], options['--session']);
  if (mode === 'run' && !options['--execute']) { emit({ status: 'PLAN_ONLY', ...p }); return; }
  need(mode !== 'replay' || options['--execute'], 'replay requires explicit --execute');
  need(options['--base'], 'explicit --base required');
  const api = connection(options['--base']), info = await discover(api);
  if (mode === 'discover') { emit({ status: 'DISCOVER_ONLY', ...info }); return; }
  preflight(info, p);
  if (mode === 'run') {
    const existing = await records(info, p);
    need(existing.fanoutTicketIds.length === 0, `main thread would fan out to existing tickets: ${existing.fanoutTicketIds.join(',')}; stop and review separately`);
    need(!lstatSync(p.directory, { throwIfNoEntry: false }) && !existing.triggers.length && !existing.tickets.length, 'run already exists; inspect instead of submitting again');
    const history = await events(api, p.sessionId);
    need(!history.some(e => e.type === 'user/message' && e.data?.source?.rpcId === p.requestId), 'request already admitted; inspect instead');
    // No retry here: an interrupted admission is ambiguous until inspected by the operator.
    need((await api.rpc('prompt', p.request))?.accepted === true, 'prompt not accepted');
    emit({ status: 'ADMITTED_NOT_ACCEPTED', runId: p.runId, requestId: p.requestId, mainSessionId: p.sessionId,
      receiptPath: p.path, ticketId: null, workerSessionId: null, next: 'inspect with the same run-id/session' }); return;
  }
  const before = checkSnapshot(await snapshot(api, info, p));
  if (mode === 'inspect') { emit({ status: 'LIVE_SINGLE_OBSERVATION_PASS', evidence: before, idempotency: 'not_exercised' }); return; }
  need((await api.rpc('prompt', p.request))?.accepted === true, 'replay not accepted');
  await new Promise(resolve => setTimeout(resolve, 2000));
  const after = checkSnapshot(await snapshot(api, info, p));
  need(JSON.stringify(before) === JSON.stringify(after), 'replay changed ticket/file/delivery evidence');
  emit({ status: 'LIVE_REQUEST_REPLAY_PASS', evidence: after, observationMs: 2000,
    limit: 'Same requestId replay and no duplicate delivery observed; no forced outbox crash/retry or restart was performed.' });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    // Avoid printing server bodies, credentials, or arbitrary Session content on errors.
    console.error(JSON.stringify({ status: 'REJECTED_OR_INCOMPLETE', error: error.message }));
    process.exitCode = 1;
  });
}
