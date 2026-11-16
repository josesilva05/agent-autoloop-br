// Tudo que pode mudar a central é decidido aqui: dada a view e uma entrada, os fatos a registrar e a resposta a dar.
// Tempo e segredos entram como argumentos, então a mesma entrada sobre a mesma view decide sempre o mesmo.
import { credential, digest, type Environment } from "./credentials.ts";
import { latestBefore, nextRun, parseCron } from "./cron.ts";
import { deadlines, MINUTE, offlineCard, OFFLINE_AFTER, RUN_LEASE, SEEN_EVERY, WORKER_FRESH } from "./due.ts";
import { AuthError, Conflict, InputError, NotFound } from "./errors.ts";
import { iso, rows, type Change, type Fact, type Row, type Table, type View } from "./evolve.ts";
import {
  agentsOf,
  cardView,
  configuration,
  eventsOf,
  jobOf,
  openInScope,
  pauseOf,
  routingOf,
  sourceOf,
  waitingOn,
  workerOf,
  workers,
} from "./query.ts";
import { cronOf, eventRule, ruleOf, SCHEDULE, typeMatches, type Rule, type Rules } from "./rules.ts";
import {
  addUsage,
  ANSWER_BY,
  ANSWER_REF,
  ANSWER_TEXT,
  DELIVERY_REF,
  parseEvent,
  parseResult,
  type Later,
  type Rejected,
  type Result,
} from "../protocol/validate.ts";

export type Input = { type: string; args: any[] };

/** Minutos após a primeira tentativa em que um cartão é enviado de novo a um canal. */
const RESEND_AT = [0, 1, 3, 7, 15, 25, 35, 45, 55];
/** O último reenvio e o minuto em que ele segura o cartão: depois disso um canal desistiu. */
const RESEND_WINDOW = 57 * MINUTE;
/** Quanto uma cadeia de eventos que causam eventos pode crescer antes de parar de ser despachada. */
const MAX_HOPS = 8;
/** Falhas seguidas após as quais uma rodada deixa de ser repetida: cada tentativa gasta tokens reais do titular. */
const MAX_ATTEMPTS = 10;
const NOT_TRYING = { tries: 0, first_try_at: null, not_before: null };
const NOT_DELIVERED: Row = { version: 0, ref: null, ...NOT_TRYING, error: null, given_up: 0 };

const nulls = (...names: string[]) => Object.fromEntries(names.map((name) => [name, null]));
const CARD_BASICS = { text: "", options: "[]", recommend: null, about: "", state: "open", fyi: 0, quiet: 0 };
const DEFAULTS: Partial<Record<Table, Row>> = {
  runs: {
    attempts: 0,
    ...nulls("claim", "issued", "last_issued", "last_result", "last_answer", "cancel_at", "resume", "session", "link"),
    ...nulls("claimed_at", "seen_at", "finished_at", "summary", "error", "usage"),
  },
  cards: {
    ...CARD_BASICS,
    ...nulls("choice", "answer", "by", "result", "rule"),
    lane: "",
    ...nulls("grp", "source", "agent", "session", "run_id", "answer_event"),
    version: 1,
    ...nulls("decided_at", "closed_at"),
  },
  deliveries: NOT_DELIVERED,
};

type Given = { type: string; seq: number; now: number; at: string; env: Environment; rules: Rules };
/** Uma entrada sendo decidida: o que vale o tempo todo e a view com as mudanças feitas até aqui. */
type Draft = Given & { view: View; changes: Change[] };

export function decide(view: View, input: Input, now: number, env: Environment): { facts: Fact[]; value: any } {
  const { type, args } = input;
  if (!Object.hasOwn(HANDLERS, type)) throw new InputError(`entrada desconhecida: ${type}`);
  const rules = configuration(view);
  const draft: Draft = { view: view.fork(), seq: view.seq + 1, type, now, at: iso(now), env, rules, changes: [] };
  const value = HANDLERS[type](draft, ...args);
  // Sem nada mudado nada de novo pode vencer, e o que só o relógio muda tem um vencimento próprio para trazer um tick.
  if (!draft.changes.length && type !== "tick") return { facts: [], value };
  const due = deadlines(draft.view, now);
  for (const [key, row] of Object.entries(due)) {
    if (JSON.stringify(draft.view.get("due", key)) !== JSON.stringify(row)) put(draft, "due", key, row);
  }
  for (const { kind, key: name } of rows(draft.view, "due")) {
    const key = `${kind}:${name}`;
    if (!due[key]) set(draft, "due", key, null);
  }
  return { facts: draft.changes.length ? [factOf(draft, draft.changes)] : [], value };
}

function factOf({ seq, now, type }: Draft, changes: Change[]): Fact {
  return { version: 1, seq, at: now, type, changes };
}

function set(draft: Draft, table: Table, key: string | number, row: Row | null) {
  const change = { table, key: String(key), row };
  draft.changes.push(change);
  draft.view.set(table, String(key), row);
  return row!;
}

const put = (draft: Draft, table: Table, key: string | number, fields: Row) =>
  set(draft, table, key, { ...DEFAULTS[table], ...draft.view.get(table, key), ...fields });

function add(draft: Draft, table: Table, fields: Row) {
  const id = (draft.view.next[table] ?? 0) + 1;
  return put(draft, table, id, { ...fields, id });
}

const ruleNamed = (draft: Draft, name: string) => ruleOf(draft.rules, name);
function assignQueued(draft: Draft, run: Row) {
  const config = draft.view.get("config", "rules")!;
  const rule = ruleOf(config.value as Rules, run.rule);
  if (!rule) return;
  const session = rule.to === run.agent ? {} : nulls("session", "resume");
  put(draft, "runs", run.id, { agent: rule.to, rules_version: config.version, ...session });
}
const threadOf = (run: Row) => ({ rule: run.rule, lane: run.lane, grp: run.grp });

/** A sessão em que continua uma rodada prestes a começar. Com resume, uma sem sessão pega a última do assunto, a menos que
 * aquela rodada tenha sido interrompida: o que a interrompeu, ou o motivo do titular, encontraria esta também. Rodadas de
 * um assunto podem compartilhar sessão, então outra ainda em curso, ou uma perdida de vista, pode estar rodando nela: um
 * segundo processo não pode abri-la, e uma nova é aberta. */
function settleSession(draft: Draft, run: Row) {
  const rule = ruleNamed(draft, run.rule);
  const thread = { rule: run.rule, lane: run.lane };
  const carried = run.session ?? run.resume;
  let session = carried;
  if (!session && rule?.resume) {
    const [last] = rows(draft.view, "runs", { ...thread, state: ["done", "nothing", "cancelled"] }, 1, true);
    if (last?.state !== "cancelled" && last?.agent === rule.to) session = last.session;
  }
  if (!session) return;
  const going = rows(draft.view, "runs", { ...thread, state: ["claimed", "unknown"] });
  if (going.some((other) => (other.session ?? other.resume) === session)) {
    put(draft, "runs", run.id, nulls("session", "resume"));
  } else if (session !== carried) put(draft, "runs", run.id, { resume: session });
}
const hopsOf = (draft: Draft, run: Row) => Math.max(0, ...eventsOf(draft.view, run.id).map((event) => event.hops ?? 0));

function closeCard(draft: Draft, card: Row, result: string, by: string | null = null, note: string | null = null) {
  const closed = { state: "closed", closed_at: draft.at, version: card.version + 1 };
  // Uma observação diz como uma notificação foi tratada, para consultar depois.
  put(draft, "cards", card.id, { ...closed, result, by: by ?? card.by, ...(note ? { answer: note } : {}) });
}

function closeOpen(draft: Draft, matches: (key: string) => boolean, result: string) {
  const open = rows(draft.view, "cards", { state: "open" }).filter((card) => matches(card.key));
  for (const card of open) closeCard(draft, card, result);
}

/** Depois de interrompida, nada deve continuar dizendo que vai tentar de novo, ou que talvez ainda esteja em curso. */
const closeStopped = (draft: Draft, run: number, result: string) =>
  closeOpen(draft, (key) => key === `run:${run}:failing` || key === `run:${run}:unknown`, result);

const closeOffline = (draft: Draft, worker: string) =>
  closeOpen(draft, (key) => key.startsWith(`worker:${worker}:offline:`), "conectou");

/** Se um registro novo diria algo que este já não diz. Um no futuro significa que o relógio foi atrasado: é refeito. */
function justSeen({ now }: Draft, row?: Row) {
  const age = now - Date.parse(row?.seen_at);
  return age >= 0 && age < SEEN_EVERY;
}

function createCard(draft: Draft, spec: Row) {
  const [existing] = rows(draft.view, "cards", { key: spec.key, ...(!spec.once && { state: "open" }) }, 1, true);
  if (existing) return { card: existing.id, duplicate: true };
  const { once, run, options, fyi, quiet, ...fields } = spec;
  const stored = {
    run_id: run ?? null,
    options: JSON.stringify(options ?? []),
    fyi: fyi ? 1 : 0,
    quiet: quiet ? 1 : 0,
  };
  const state = fyi ? { state: "closed", closed_at: draft.at } : { state: "open" };
  const card = add(draft, "cards", { ...fields, ...stored, ...state, created_at: draft.at });
  return { card: card.id, duplicate: false };
}

const notify = (draft: Draft, key: string, title: string, text: string, extra: Row = {}) =>
  createCard(draft, { key, kind: "notice", title, text, ...extra });

/** Uma rodada na fila desta regra e deste assunto pega o evento, então o que chega enquanto ela espera é tratado junto. */
function enqueue(draft: Draft, rule: Rule, event: number, lane: string, resume?: string | null) {
  const rulesVersion = draft.view.get("config", "rules")!.version;
  const stamps = { not_before: draft.at, created_at: draft.at, rules_version: rulesVersion };
  const run =
    rows(draft.view, "runs", { rule: rule.name, lane, state: "queued" })[0] ??
    add(draft, "runs", { rule: rule.name, agent: rule.to, grp: rule.group, lane, state: "queued", ...stamps });
  put(draft, "run_events", `${run.id}:${event}`, { run_id: run.id, event_id: event });
  if (resume) put(draft, "runs", run.id, { resume });
  return run.id as number;
}

/** Mantém um evento sob uma chave só dele: uma que a central inventa não pode colidir com uma que a fonte enviou. */
function recordEvent(
  draft: Draft,
  source: string,
  event: Row,
  routed: string[],
  paused: string[] = [],
  sent = false,
): number {
  let key = event.id;
  for (let suffix = 1; rows(draft.view, "events", { source, key }).length; suffix++) {
    key = `${event.id}:${suffix}`;
  }
  return add(draft, "events", {
    source,
    key,
    type: event.type,
    subject: event.subject ?? "",
    summary: event.summary ?? "",
    detail: event.detail ?? "",
    link: event.link ?? "",
    hops: event.hops ?? 0,
    routed: JSON.stringify(routed),
    // Só onde uma pausa o segurou, para que a lista do titular com o que foi pulado leia um índice apenas desses.
    ...(paused.length && { paused: JSON.stringify(paused) }),
    // Pela porta da própria fonte: só estes ela pode ler de volta (`eventOutcome`), não o que a central fez em seu nome.
    ...(sent && { sent: 1 }),
    received_at: draft.at,
  }).id;
}

function ingest(draft: Draft, source: string, given: unknown, sent = false) {
  const event = parseEvent(given);
  const existing = rows(draft.view, "events", { source, key: event.id })[0];
  if (existing) {
    return { event: existing.id, duplicate: true, ...routingOf(existing) };
  }
  const tooDeep = event.hops > MAX_HOPS;
  const takes = (rule: Rule) =>
    eventRule(rule) && rule.when.source === source && typeMatches(rule.when.types, event.type);
  const matched = tooDeep ? [] : draft.rules.rules.filter(takes);
  // Uma regra pausada não pega o evento, e nada fica guardado para ela: o evento é registrado como pulado por ela.
  const isPaused = (rule: Rule) => !!pauseOf(draft.view, rule, draft.now);
  const paused = matched.filter(isPaused).map((rule) => rule.name);
  const taking = matched.filter((rule) => !isPaused(rule));
  const id = recordEvent(
    draft,
    source,
    event,
    matched.map((rule) => rule.name),
    paused,
    sent,
  );
  if (tooDeep) {
    const words = `A mesma cadeia de tratamento passou de ${MAX_HOPS} saltos; os eventos seguintes foram registrados, mas não continuam sendo despachados.`;
    notify(draft, `hops:${source}:${event.id}`, "Ciclo de eventos interrompido", words, { once: true });
  }
  for (const rule of taking) enqueue(draft, rule, id, rule.parallel ? event.subject : "");
  return { event: id, duplicate: false, routed: taking.map((rule) => rule.name), paused };
}

function heldRun(draft: Draft, id: number, token: string, states: string[]) {
  const run = draft.view.get("runs", id);
  const issued = run && states.includes(run.state) && run.issued !== null;
  if (!issued || credential(draft.env, "run", id, run.issued) !== token)
    throw new AuthError("este trabalho não pertence a este token");
  return run;
}

function cardFromReceipt(draft: Draft, run: Row, kind: string, card: Row) {
  const name = card.key ?? digest(`${card.title}\n${card.text}`).slice(0, 32);
  const session = draft.view.get("runs", run.id)!.session;
  const fyi = kind === "notice" && card.fyi === true;
  const quiet = kind === "notice" && ruleNamed(draft, run.rule)?.tell === "never";
  const origin = { source: sourceOf(draft.view, run.id), agent: run.agent, session, run: run.id };
  const key = `thread:${run.rule}:${run.lane}:${name}`;
  // Fechado já na criação, nada em aberto impede que volte: uma rodada que tenta de novo o diz uma única vez.
  if (fyi && rows(draft.view, "cards", { key, run_id: run.id }, 1).length) return;
  createCard(draft, { ...card, hops: hopsOf(draft, run), key, kind, fyi, quiet, ...threadOf(run), ...origin });
}

/** Notifica o que ficou em silêncio: um worker que parou de vir, uma rodada que o worker parou de mencionar. */
function sweep(draft: Draft) {
  const { now } = draft;
  for (const worker of workers(draft.view)) {
    const seen = draft.view.get("seen", `worker:${worker}`);
    const lastSeen = seen ? Date.parse(seen.seen_at) : undefined;
    if (lastSeen !== undefined && now - lastSeen <= WORKER_FRESH) {
      closeOffline(draft, worker);
      const inDoubt = (run: Row) => workerOf(draft.view, run) === worker && Date.parse(run.seen_at) < now - RUN_LEASE;
      for (const run of rows(draft.view, "runs", { state: "claimed" }).filter(inDoubt)) {
        put(draft, "runs", run.id, { state: "unknown" });
        const agent = configuration(draft.view, run.rules_version).agents[run.agent].name;
        const words = `Entregue a ${agent}, já passou de 5 minutos sem notícia; Incerto se terminou ou não. As novas tarefas seguem sendo tratadas normalmente.`;
        notify(draft, `run:${run.id}:unknown`, run.rule, words, threadOf(run));
      }
    }
    const waiting = waitingOn(draft.view, worker, now);
    if (!waiting.length) continue;
    const since = now - (lastSeen ?? Date.parse(waiting[0].created_at));
    const { key, told } = offlineCard(draft.view, worker, waiting);
    if (since <= OFFLINE_AFTER || told) continue;
    const minutes = Math.floor(since / MINUTE);
    const neverSeen = lastSeen === undefined;
    const situation = neverSeen
      ? `${worker} nunca conectou à central; ${waiting.length} tarefa(s) esperam há ${minutes} minutos sem ninguém`
      : `${worker} está há ${minutes} minutos sem conectar à central; ${waiting.length} tarefa(s) na fila ou em curso`;
    const check = neverSeen ? "se está ligado e na rede" : "se desligou, hibernou ou perdeu a rede";
    notify(draft, key, "o worker não conectou", `${situation} (dê uma olhada naquele computador: ${check}).`);
  }
}

function claimNext(draft: Draft, worker: string, claim: string) {
  const agents = agentsOf(draft.view, worker);
  const runs = rows(draft.view, "runs", { state: ["queued", "claimed"] });
  const claimed = runs.filter((run) => run.state === "claimed");
  const groupLimit = (group: string) => draft.rules.rules.find((rule) => rule.group === group)?.parallel ?? 1;
  const claimable = (run: Row) => {
    if (run.state !== "queued") return false;
    const rule = ruleNamed(draft, run.rule);
    // O que estava na fila antes de uma pausa, ou uma resposta que chegou durante ela, espera a retomada.
    if (!rule || !agents.includes(rule.to) || pauseOf(draft.view, rule, draft.now)) return false;
    const agentLimit = draft.rules.agents[rule.to].maxActive;
    return (
      Date.parse(run.not_before) <= draft.now &&
      !claimed.some((other) => other.grp === run.grp && other.lane === run.lane) &&
      claimed.filter((other) => other.grp === run.grp).length < groupLimit(run.grp) &&
      (rule.maxActive === undefined || claimed.filter((other) => other.rule === run.rule).length < rule.maxActive) &&
      (agentLimit === undefined || claimed.filter((other) => other.agent === rule.to).length < agentLimit)
    );
  };
  // O mesmo claim de novo significa que a resposta se perdeu: ele recebe de volta a rodada que já tem.
  const held = claimed.find((run) => run.claim === claim && workerOf(draft.view, run) === worker);
  const run = held ?? runs.find(claimable);
  if (!run) return null;
  if (!held) {
    assignQueued(draft, run);
    settleSession(draft, draft.view.get("runs", run.id)!);
  }
  const since = held ? { claimed_at: run.claimed_at, link: run.link } : { claimed_at: draft.at, link: null };
  const rules_version = held ? run.rules_version : draft.view.get("config", "rules")!.version;
  const claiming = { state: "claimed", claim, issued: draft.seq, seen_at: draft.at, rules_version, ...since };
  put(draft, "runs", run.id, { ...claiming, ...nulls("last_issued", "last_result", "last_answer") });
  return jobOf(draft.view, draft.view.get("runs", run.id)!, draft.env);
}

/** Encerra uma rodada que nada vai pegar de novo, e diz isso. */
function stopRun(draft: Draft, run: Row, why: string, summary: string, words: string) {
  put(draft, "runs", run.id, { state: "cancelled", finished_at: draft.at, summary });
  closeStopped(draft, run.id, summary);
  notify(draft, `run:${run.id}:${why}`, run.rule, words, threadOf(run));
}

const ruleGone = (run: Row): [string, string] => [
  `A regra "${run.rule}" não existe mais, sem novos despachos`,
  `A regra "${run.rule}" não existe mais (foi apagada ou renomeada) e a rodada na fila não será mais despachada. Se ainda for preciso fazer, dispare o assunto de novo.`,
];

/** Uma rodada que não conseguiu terminar espera para tentar de novo, e leva junto o que chegou para a mesma coisa enquanto isso. */
function retryLater(draft: Draft, run: Row, result: Result) {
  const { id } = run;
  const attempts = run.attempts + 1;
  const notBefore = draft.now + Math.min(5 * MINUTE * 2 ** (attempts - 1), 60 * MINUTE);
  const error = (result.error ?? "").trim().replace(/[.\u3002]+$/, "") || "sem motivo informado";
  const unclaimed = nulls("claim", "claimed_at", "seen_at", "cancel_at");
  const rejected: Rejected[] = [];
  for (const what of ["ask", "resolve", "later", "events"] as const) {
    for (const _ of result[what] ?? [])
      rejected.push({ what, reason: "uma rodada que falhou só pode enviar notificação" });
  }
  for (const notice of result.notice ?? []) cardFromReceipt(draft, run, "notice", notice);
  const failure = { attempts, error, ...unclaimed };
  if (!ruleNamed(draft, run.rule)) {
    put(draft, "runs", id, failure);
    stopRun(draft, run, "rule-gone", ...ruleGone(run));
    return rejected;
  }
  if (attempts >= MAX_ATTEMPTS) {
    // Rodadas na fila deste assunto ficam separadas: chegaram depois e têm a própria contagem e a própria vez.
    const summary = `Não concluiu ${MAX_ATTEMPTS} vezes seguidas, sem nova tentativa automática`;
    const words = `O tratamento automático não concluiu ${MAX_ATTEMPTS} vezes seguidas (parou em: ${error}); não haverá mais nova tentativa automática. Depois de resolver, dispare o assunto de novo e ele começará do zero.`;
    put(draft, "runs", id, failure);
    stopRun(draft, run, "stopped", summary, words);
    return rejected;
  }
  put(draft, "runs", id, { state: "queued", not_before: iso(notBefore), ...failure });
  const waiting = rows(draft.view, "runs", { rule: run.rule, lane: run.lane, state: "queued" });
  for (const other of waiting.filter((other) => other.id !== id)) {
    for (const link of rows(draft.view, "run_events", { run_id: other.id })) {
      put(draft, "run_events", `${id}:${link.event_id}`, { run_id: id, event_id: link.event_id });
      set(draft, "run_events", `${other.id}:${link.event_id}`, null);
    }
    set(draft, "runs", other.id, null);
    if (other.resume) put(draft, "runs", id, { resume: other.resume });
  }
  if (!result.notice?.some((notice) => !notice.fyi) && attempts === 3) {
    const clock = { timeZone: draft.rules.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" } as const;
    const time = new Intl.DateTimeFormat("pt-BR", clock).format(notBefore);
    const words = `O tratamento automático não concluiu 3 vezes seguidas (parou em: ${error}); nova tentativa automática às ${time}.`;
    notify(draft, `run:${id}:failing`, run.rule, words, threadOf(run));
  }
  assignQueued(draft, draft.view.get("runs", id)!);
  return rejected;
}

function scheduleReview(draft: Draft, run: Row, later: Later) {
  const { rule, lane } = run;
  const [existing] = rows(draft.view, "timers", { rule, lane, key: later.key, event_id: null });
  if (later.cancel) {
    if (existing) set(draft, "timers", existing.id, null);
    return;
  }
  const session = draft.view.get("runs", run.id)!.session;
  const fields = {
    at: iso(Date.parse(later.at!)),
    about: later.about,
    session,
    agent: run.agent,
    hops: hopsOf(draft, run),
  };
  if (existing) return void put(draft, "timers", existing.id, fields);
  const source = sourceOf(draft.view, run.id) ?? SCHEDULE;
  add(draft, "timers", { ...fields, rule, lane, key: later.key, source, event_id: null, created_at: draft.at });
}

/** Um recibo entra em vigor aqui, inteiro em um único fato. */
function applyReceipt(draft: Draft, run: Row, result: Result) {
  const { id } = run;
  const rule = ruleNamed(draft, run.rule);
  const summary = result.summary ?? "";
  const rejected: Rejected[] = [];
  put(draft, "runs", id, { state: result.outcome, finished_at: draft.at, summary, error: null, cancel_at: null });
  closeOpen(draft, (key) => key === `run:${id}:failing`, "concluiu depois");
  closeOpen(draft, (key) => key === `run:${id}:unknown`, "o resultado chegou");
  const eventIds = eventsOf(draft.view, id).map((event) => event.id);
  for (const card of rows(draft.view, "cards", { answer_event: eventIds, state: "decided" })) {
    put(draft, "cards", card.id, { state: "done", result: summary, closed_at: draft.at, version: card.version + 1 });
  }
  for (const item of result.resolve ?? []) {
    const card = openInScope(draft.view, run).find((card) => card.id === item.card);
    if (card) closeCard(draft, card, item.reason.trim(), `rodada ${id}`);
    else rejected.push({ card: item.card, reason: "fora do escopo de verificação desta rodada" });
  }
  for (const ask of result.ask ?? []) cardFromReceipt(draft, run, "ask", ask);
  for (const notice of result.notice ?? []) cardFromReceipt(draft, run, "notice", notice);
  if (rule?.tell === "always" && result.outcome === "done") {
    const once = { fyi: true, once: true, ...threadOf(run), source: sourceOf(draft.view, id), run: id };
    notify(draft, `run:${id}:done`, run.rule, summary, once);
  }
  for (const later of result.later ?? []) scheduleReview(draft, run, later);
  const emitted: number[] = [];
  for (const event of result.events ?? []) {
    if (rule?.emits && typeMatches(rule.emits.types, event.type)) {
      const sent = ingest(draft, rule.emits.source, { ...event, hops: hopsOf(draft, run) + 1 });
      // Um número já tomado é de um evento anterior, talvez de outra fonte: o que ele diz não é o que este recibo enviou.
      if (!sent.duplicate) emitted.push(sent.event);
    } else rejected.push({ what: "events", reason: `a regra "${run.rule}" não declara que pode emitir ${event.type}` });
  }
  // A fonte cujo evento esta rodada pegou os lê de volta (`eventOutcome`); nada mais os liga à rodada.
  if (emitted.length) put(draft, "runs", id, { emitted: JSON.stringify(emitted) });
  return rejected;
}

function finish(draft: Draft, id: number, token: string, given: unknown) {
  const hash = digest(JSON.stringify(given ?? null));
  const prior = draft.view.get("runs", id);
  // A mesma execução entregando de novo significa que a resposta se perdeu: recebe a mesma resposta e nada acontece duas vezes.
  if (prior && prior.last_issued !== null && credential(draft.env, "run", id, prior.last_issued) === token) {
    if (prior.last_result !== hash) throw new Conflict("esta execução já entregou um resultado diferente");
    return { rejected: JSON.parse(prior.last_answer ?? "[]"), duplicate: true };
  }
  const run = heldRun(draft, id, token, ["claimed", "unknown"]);
  const result = parseResult(given);
  const session = result.session ?? run.session;
  const usage = result.usage
    ? JSON.stringify(addUsage(run.usage ? JSON.parse(run.usage) : undefined, result.usage))
    : run.usage;
  put(draft, "runs", id, { last_issued: run.issued, last_result: hash, issued: null, session, usage });
  let rejected: Rejected[] = [];
  // Com ordem de parada, uma que falhou antes parou do mesmo jeito: tentar de novo iniciaria o que o titular encerrou.
  if (result.outcome === "cancelled" || (result.outcome === "failed" && run.cancel_at)) {
    put(draft, "runs", id, {
      state: "cancelled",
      finished_at: draft.at,
      summary: result.summary ?? "",
      cancel_at: null,
    });
    closeStopped(draft, id, "Interrompida");
  } else if (result.outcome === "failed") rejected = retryLater(draft, run, result);
  else rejected = applyReceipt(draft, run, result);
  put(draft, "runs", id, { last_answer: JSON.stringify(rejected) });
  return { rejected };
}

function answer(draft: Draft, id: number, given: Row) {
  const card = draft.view.get("cards", id);
  if (!card) throw new NotFound("não existe este cartão");
  if (given.channel !== undefined) {
    const allowed = draft.rules.channels[given.channel]?.answerers;
    if (allowed && !allowed.includes(given.by ?? ""))
      throw new AuthError("esta pessoa não pode responder a este cartão");
    const delivery = draft.view.get("deliveries", `${id}:${given.channel}`);
    if (!delivery?.ref || delivery.ref !== given.ref) throw new AuthError("não é a mensagem que foi enviada");
  }
  if (card.state !== "open") return { changed: false, state: card.state };
  if (given.by !== undefined && (typeof given.by !== "string" || [...given.by].length > ANSWER_BY)) {
    throw new InputError(`quem responde aceita no máximo ${ANSWER_BY} caracteres`);
  }
  if (given.ref !== undefined && (typeof given.ref !== "string" || [...given.ref].length > ANSWER_REF)) {
    throw new InputError(`o número da mensagem aceita no máximo ${ANSWER_REF} caracteres`);
  }
  const words = card.kind === "notice" ? "nota de tratamento" : "resposta";
  if (given.text !== undefined && typeof given.text !== "string") throw new InputError(`${words} precisa ser texto`);
  const text = given.text?.trim() || null;
  if (text !== null && [...text].length > ANSWER_TEXT)
    throw new InputError(`${words} aceita no máximo ${ANSWER_TEXT} caracteres`);
  if (card.kind === "notice") {
    closeCard(draft, card, "Resolvido", given.by ?? null, text);
    return { changed: true, state: "closed" };
  }
  const optionCount = JSON.parse(card.options).length;
  const inRange = Number.isInteger(given.choice) && given.choice >= 0 && given.choice < optionCount;
  if (given.choice === undefined ? !text : !inRange) throw new InputError("Esta opção não existe");
  const rule = card.rule ? ruleNamed(draft, card.rule) : undefined;
  const { lane: subject, title: summary, hops = 0 } = card;
  const event = { id: `card:${id}`, type: "card.answered", subject, summary, hops };
  const eventId = recordEvent(draft, card.source ?? SCHEDULE, event, rule ? [rule.name] : []);
  const decision = { choice: given.choice ?? null, answer: text, by: given.by ?? null, decided_at: draft.at };
  put(draft, "cards", id, { state: "decided", ...decision, answer_event: eventId, version: card.version + 1 });
  if (rule) enqueue(draft, rule, eventId, card.lane, card.agent === rule.to ? card.session : null);
  return { changed: true, state: "decided" };
}

function nextCard(draft: Draft, channel: string) {
  const { now } = draft;
  for (const card of draft.view.deliveryCandidates(channel, now)) {
    const reach = (card.rule ? ruleNamed(draft, card.rule)?.channels : undefined) ?? draft.rules.defaultChannels;
    if (reach && !reach.includes(channel)) continue;
    const key = `${card.id}:${channel}`;
    const delivery = draft.view.get("deliveries", key) ?? NOT_DELIVERED;
    const recentNote = card.fyi && Date.parse(card.created_at) >= now - 24 * 60 * MINUTE;
    const worthSending = card.state === "open" || delivery.ref !== null || recentNote;
    const resting = delivery.not_before && Date.parse(delivery.not_before) > now;
    if (card.quiet || delivery.version >= card.version || delivery.given_up || resting || !worthSending) continue;
    const firstTry = delivery.first_try_at;
    if (delivery.tries >= RESEND_AT.length || (firstTry && now - Date.parse(firstTry) > RESEND_WINDOW)) {
      put(draft, "deliveries", key, { given_up: 1 });
      continue;
    }
    const attempt = { tries: delivery.tries + 1, first_try_at: firstTry ?? draft.at, not_before: iso(now + MINUTE) };
    put(draft, "deliveries", key, { card_id: card.id, channel, ...attempt });
    return cardView(card, draft.env, delivery.ref, draft.rules.channels[channel]?.links === true);
  }
  return null;
}

/** O que o relógio trouxe: agendamentos chegam, reverificações vencem e tudo que ficou em silêncio. */
function tick(draft: Draft) {
  const { now } = draft;
  const { rules, timezone } = draft.rules;
  for (const pause of rows(draft.view, "pauses")) {
    if (pause.until === null || Date.parse(pause.until) > now) continue;
    set(draft, "pauses", pause.name, null);
    reopen(draft, pause.name, Date.parse(pause.until));
  }
  for (const rule of rules) {
    if (eventRule(rule)) continue;
    const text = cronOf(rule);
    const cron = parseCron(text)!;
    const schedule = draft.view.get("schedules", rule.name);
    const nextAt = () => iso(nextRun(cron, now, timezone)!);
    if (!schedule || schedule.cron !== text) {
      put(draft, "schedules", rule.name, { rule: rule.name, cron: text, next_at: nextAt() });
      continue;
    }
    if (now < Date.parse(schedule.next_at)) continue;
    const slot = iso(latestBefore(cron, Date.parse(schedule.next_at), now, timezone));
    // Pausada, o momento passa sem rodada e o próximo é o próximo: uma retomada não deve nada.
    if (pauseOf(draft.view, rule, now)) {
      put(draft, "schedules", rule.name, { next_at: nextAt(), skipped_at: slot });
      continue;
    }
    const key = `${rule.name}@${slot}`;
    if (!rows(draft.view, "events", { source: SCHEDULE, key }).length) {
      enqueue(draft, rule, recordEvent(draft, SCHEDULE, { id: key, type: "schedule.tick" }, [rule.name]), "");
    }
    put(draft, "schedules", rule.name, { next_at: nextAt() });
  }
  const due = rows(draft.view, "timers", { event_id: null }).filter((timer) => Date.parse(timer.at) <= now);
  for (const timer of due.sort((a, b) => a.at.localeCompare(b.at))) {
    const rule = ruleNamed(draft, timer.rule);
    const event = { id: `timer:${timer.id}`, type: "timer.due", subject: timer.lane, hops: timer.hops ?? 0 };
    const eventId = recordEvent(draft, timer.source, event, rule ? [rule.name] : []);
    put(draft, "timers", timer.id, { event_id: eventId });
    if (rule) enqueue(draft, rule, eventId, timer.lane, timer.agent === rule.to ? timer.session : null);
  }
  sweep(draft);
}

/** Um agendamento cujo próximo momento passou durante a pausa recomeça no primeiro momento a partir de `from`, sem acumular. */
function reopen(draft: Draft, name: string, from: number) {
  const rule = draft.rules.rules.find((rule) => rule.name === name);
  if (!rule || eventRule(rule)) return;
  const schedule = draft.view.get("schedules", rule.name);
  if (!schedule || Date.parse(schedule.next_at) >= from) return;
  const next = nextRun(parseCron(cronOf(rule))!, from - 1, draft.rules.timezone);
  put(draft, "schedules", rule.name, { next_at: iso(next!) });
}

function knownRule(draft: Draft, name: string) {
  // Não é ruleNamed: uma tarefa em outro lugar que pode perguntar segue como uma regra, mas a central não a inicia nem a segura.
  const rule = draft.rules.rules.find((rule) => rule.name === name);
  if (rule) return rule;
  if (draft.rules.elsewhere.some((task) => task.name === name)) {
    throw new InputError(
      `"${name}" é uma tarefa agendada executada em outro lugar; a central não a inicia, então não pode pará-la nem executá-la`,
    );
  }
  throw new NotFound(`Não existe esta regra: ${name}`);
}

const PAUSE_REASON = 500;
function pauseFields(draft: Draft, given: Row) {
  const { reason = "", until = null } = given ?? {};
  if (typeof reason !== "string" || [...reason].length > PAUSE_REASON) {
    throw new InputError(`o motivo da pausa precisa ser um texto de até ${PAUSE_REASON} caracteres`);
  }
  const ends = typeof until === "string" && /(Z|[+-]\d\d:\d\d)$/.test(until) ? Date.parse(until) : NaN;
  if (until !== null && !(ends > draft.now))
    throw new InputError("until precisa ser um horário ISO com fuso e posterior ao agora");
  return { reason: reason.trim(), until: until === null ? null : iso(ends) };
}

const pauseView = ({ by, reason, since, until }: Row) => ({ by, reason, since, until });

/** Ações do titular sobre uma regra. São fatos no log, não edições no rules.json. */
const CONTROL = {
  pauseRule(draft: Draft, name: string, by: string, given: Row) {
    knownRule(draft, name);
    const fields = pauseFields(draft, given);
    const existing = draft.view.get("pauses", name);
    const same = existing && existing.reason === fields.reason && existing.until === fields.until;
    if (!same) put(draft, "pauses", name, { name, by, since: existing?.since ?? draft.at, ...fields });
    return { changed: !same, rule: name, paused: pauseView(draft.view.get("pauses", name)!) };
  },
  resumeRule(draft: Draft, name: string) {
    // Uma regra tirada do rules.json enquanto pausada ainda pode ter a pausa desfeita.
    const pause = draft.view.get("pauses", name);
    if (!pause) {
      knownRule(draft, name);
      return { changed: false, rule: name };
    }
    set(draft, "pauses", name, null);
    reopen(draft, name, draft.now);
    // Qual pausa era: o que ela pulou é lido a partir de quando começou, e depois que some nada mais diz quando foi.
    return { changed: true, rule: name, paused: pauseView(pause) };
  },
  /** Eventos que uma pausa impediu de chegar à regra, pegos por ela agora como teriam sido então: cada um uma vez, nunca durante a pausa. */
  replayRule(draft: Draft, name: string, events: number[]) {
    const rule = knownRule(draft, name);
    if (!eventRule(rule))
      throw new InputError(
        `"${name}" é uma regra agendada: durante a pausa o horário não roda e nenhum evento é registrado, então não há o que reexecutar; para repor uma rodada use run`,
      );
    if (pauseOf(draft.view, rule, draft.now))
      throw new Conflict(`a regra "${name}" está pausada; retome antes de reexecutar`);
    // Um evento fica como chegou, ainda dizendo quais pausas o pularam. O que diz que ele foi reposto é uma rodada desta
    // regra o segurando, e um link já feito só se move para outra rodada da mesma regra e do mesmo assunto.
    const taken = (id: number) =>
      rows(draft.view, "run_events", { event_id: id }).some(
        (link) => draft.view.get("runs", link.run_id)?.rule === name,
      );
    const replayed: number[] = [];
    const runs = new Set<number>();
    for (const id of [...events].sort((a, b) => a - b)) {
      const event = draft.view.get("events", id);
      if (!event || !JSON.parse(event.paused ?? "[]").includes(name) || taken(id)) continue;
      runs.add(enqueue(draft, rule, id, rule.parallel ? event.subject : ""));
      replayed.push(id);
    }
    return { events: replayed, runs: [...runs] };
  },
  /** Uma rodada agora, pela fila de sempre, a partir de um evento próprio que diz que o titular pediu. */
  runRule(draft: Draft, name: string, by: string, given: Row) {
    const rule = knownRule(draft, name);
    const { subject = "", reason = "" } = given ?? {};
    if (typeof reason !== "string" || [...reason].length > PAUSE_REASON) {
      throw new InputError(`a observação precisa ser um texto de até ${PAUSE_REASON} caracteres`);
    }
    if (pauseOf(draft.view, rule, draft.now))
      throw new Conflict(`a regra "${name}" está pausada; retome antes de executar manualmente`);
    const source = eventRule(rule) ? rule.when.source : SCHEDULE;
    // As mesmas verificações de qualquer evento: o objeto dele vira o lane e entra no prompt.
    const event = parseEvent({
      id: `manual:${draft.seq}`,
      type: "run.manual",
      subject,
      summary: `${by} executou manualmente`,
      detail: reason,
    });
    const eventId = recordEvent(draft, source, event, [name]);
    const run = enqueue(draft, rule, eventId, rule.parallel ? subject : "");
    // Esperar o backoff de uma nova tentativa não seria agora: o pedido do titular é a autorização.
    put(draft, "runs", run, { manual: 1, not_before: draft.at });
    return { event: eventId, run };
  },
};

/** Todas as entradas que existem, cada uma com seus argumentos nomeados. O que uma retorna é o que o chamador recebe. */
const HANDLERS: Record<string, (draft: Draft, ...args: any[]) => unknown> = {
  rules(draft, rules) {
    put(draft, "config", "rules", { value: rules, version: draft.seq });
    for (const run of rows(draft.view, "runs", { state: "queued" })) {
      if (ruleOf(rules, run.rule)) assignQueued(draft, run);
      else stopRun(draft, run, "rule-gone", ...ruleGone(run));
    }
    closeOpen(draft, (key) => key.startsWith("rules:"), "corrigido");
  },
  rulesError: (draft, problem) =>
    notify(
      draft,
      `rules:${digest(problem)}`,
      "o rules.json está com erro; as regras antigas continuam em uso",
      problem,
    ),
  key: (draft, kind, name, hash) =>
    void put(draft, "keys", `${kind}:${name}`, { kind, name, hash, created_at: draft.at }),
  removeKey: (draft, kind, name) => {
    if (!draft.view.get("keys", `${kind}:${name}`)) return false;
    set(draft, "keys", `${kind}:${name}`, null);
    return true;
  },
  ingest: (draft, source, given) => ingest(draft, source, given, true),
  createCard,
  /** Uma tarefa em outro lugar pergunta a você; sua resposta segue como uma rodada de regra, onde o cwd dela disser. */
  ask(draft, name, given) {
    const task = draft.rules.elsewhere.find((task) => task.name === name)!;
    if (!task.cwd)
      throw new InputError(
        `a tarefa agendada "${name}" não declara cwd; ninguém continuaria depois da resposta: só é possível usar tell`,
      );
    const { key, ...question } = given;
    const matter = key ?? digest(`${question.title}\n${question.text}`).slice(0, 32);
    const thread = { rule: name, lane: "", grp: name, source: task.source, agent: task.to };
    // Uma chave só dela: dita uma vez para sempre, uma notificação sob a mesma chave nunca chegaria depois de uma pergunta.
    return createCard(draft, { ...question, key: `elsewhere-ask:${name}:${matter}`, kind: "ask", ...thread });
  },
  tell(draft, key, title, text) {
    const told = createCard(draft, { key, title, text, kind: "notice", fyi: true, once: true });
    if (!told.duplicate) return told;
    // Dito de novo depois que todo canal desistiu dele: ganha outra chance.
    const givenUp = rows(draft.view, "deliveries", { card_id: told.card, given_up: 1 });
    for (const { card_id, channel } of givenUp) {
      put(draft, "deliveries", `${card_id}:${channel}`, { given_up: 0, ...NOT_TRYING });
    }
    if (!givenUp.length) return told;
    put(draft, "cards", told.card, { text, created_at: draft.at });
    return { ...told, duplicate: false };
  },
  heartbeat(draft, worker, running) {
    closeOffline(draft, worker);
    const held = (run?: Row) => run?.state === "claimed" && workerOf(draft.view, run) === worker;
    const inHand = running.map((id: number) => draft.view.get("runs", id)).filter(held);
    // Tudo carimbado junto, então não importa quantas rodadas um worker tem em mãos: é um fato por vez.
    if ([draft.view.get("seen", `worker:${worker}`), ...inHand].every((row) => justSeen(draft, row))) return;
    put(draft, "seen", `worker:${worker}`, { kind: "worker", name: worker, seen_at: draft.at });
    for (const run of inHand) put(draft, "runs", run.id, { seen_at: draft.at });
  },
  channelSeen(draft, name) {
    if (justSeen(draft, draft.view.get("seen", `channel:${name}`))) return;
    put(draft, "seen", `channel:${name}`, { kind: "channel", name, seen_at: draft.at });
  },
  claimNext,
  started(draft, id, token, given) {
    const { session, link } = given ?? {};
    for (const [field, value] of Object.entries({ session, link })) {
      if (value !== undefined && (typeof value !== "string" || value.length > 500)) {
        throw new InputError(`${field} precisa ser um texto de até 500 caracteres`);
      }
    }
    const run = heldRun(draft, id, token, ["claimed"]);
    put(draft, "runs", id, { session: session ?? run.session, link: link ?? run.link, seen_at: draft.at });
  },
  finish,
  cancel(draft, id) {
    const run = draft.view.get("runs", id);
    if (!run) throw new NotFound("não existe essa rodada");
    if (run.state === "queued") {
      put(draft, "runs", id, { state: "cancelled", finished_at: draft.at });
      closeStopped(draft, id, "Interrompida");
    } else if (run.state === "claimed") put(draft, "runs", id, { cancel_at: draft.at });
    else throw new InputError("esta rodada já terminou");
  },
  resolve(draft, id, reason, by) {
    const card = draft.view.get("cards", id);
    if (!card) throw new NotFound("não existe este cartão");
    if (card.state !== "open") return false;
    closeCard(draft, card, reason, by);
    return true;
  },
  answer,
  nextCard,
  delivered(draft, channel, id, version, ref) {
    if (!draft.view.get("cards", id)) throw new NotFound("não existe este cartão");
    if (ref !== null && (typeof ref !== "string" || [...ref].length > DELIVERY_REF)) {
      throw new InputError(`o número da mensagem aceita no máximo ${DELIVERY_REF} caracteres`);
    }
    const delivery = draft.view.get("deliveries", `${id}:${channel}`) ?? NOT_DELIVERED;
    const sent = { version: Math.max(delivery.version, version), ref: delivery.ref ?? ref };
    put(draft, "deliveries", `${id}:${channel}`, { card_id: id, channel, ...sent, ...NOT_TRYING, error: null });
  },
  failed(draft, channel, id, version, error) {
    const card = draft.view.get("cards", id);
    const delivery = draft.view.get("deliveries", `${id}:${channel}`);
    if (!card || !delivery) throw new NotFound("este cartão não foi entregue a este canal");
    const firstTry = delivery.first_try_at ? Date.parse(delivery.first_try_at) : draft.now;
    const next =
      version < card.version
        ? { not_before: null }
        : delivery.tries >= RESEND_AT.length
          ? { given_up: 1 }
          : { not_before: iso(firstTry + RESEND_AT[delivery.tries] * MINUTE) };
    put(draft, "deliveries", `${id}:${channel}`, { ...next, error: String(error).slice(0, 300) });
  },
  sweep,
  tick,
  ...CONTROL,
};
