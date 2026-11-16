// As portas: cada request que a central recebe, qual chave ela pede e em que entrada ele vira. Nada é decidido aqui.
import { cardPage, PAGE_HEADERS, wordsPage } from "./card-page.ts";
import { whose, type Environment } from "./credentials.ts";
import { AuthError, Conflict, InputError, NotFound } from "./errors.ts";
import { iso, type Row, type View } from "./evolve.ts";
import { agentsOf, cancels, cardView, configuration, eventOutcome } from "./query.ts";
import { eventRule, ruleOf } from "./rules.ts";
import { isAsk } from "../protocol/validate.ts";

export type Services = {
  now(): number;
  view(): View;
  environment: Environment;
  commit: string;
  dispatch(type: string, args: any[], now: number): any;
  state(now: number, before?: number): unknown;
  /** O que uma pausa reteve de uma regra desde que começou e nada recompôs ainda, do mais novo para o mais velho:
   * quantos, e o mais recente deles, ou todos. */
  skipped(rule: string, since: string, everything?: boolean): { count: number; events: Row[] };
  why(id: number): unknown;
  card(token: string): Row | undefined;
  wait(until: number, signal: AbortSignal): Promise<void>;
  stream(after: number, signal: AbortSignal, key: string): ReadableStream;
  adapt(source: string, headers: Headers, body: string): Promise<unknown[]>;
};

const MAX_BODY = 1024 * 1024;
const MAX_WAIT_SECONDS = 50;
const LINK_LIFETIME = 7 * 86400_000;
const CARD_LINK = /^\/c\/([A-Za-z0-9_-]{1,64})$/;
const POSITIVE_ID = /^[1-9][0-9]*$/;
const KEY_HOLDERS: Record<string, string> = {
  owner: "do próprio titular",
  worker: "do próprio worker",
  channel: "do próprio canal",
  source: "da própria fonte",
};
const NO_STORE = { "cache-control": "no-store" };

class TooLarge extends Error {}

async function readText(request: Request) {
  if (!request.body) return "";
  // Um pouco além do limite é lido até o fim: desligar no meio do envio pode custar ao cliente o seu 413.
  if (Number(request.headers.get("content-length")) > 8 * MAX_BODY) throw new TooLarge();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size <= MAX_BODY) chunks.push(value);
    if (size > 8 * MAX_BODY) throw new TooLarge();
  }
  if (size > MAX_BODY) throw new TooLarge();
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(request: Request) {
  const text = await readText(request);
  try {
    return JSON.parse(text);
  } catch {
    throw new InputError("não é JSON");
  }
}

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: NO_STORE });
function statusOf(error: unknown) {
  if (error instanceof TooLarge) return 413;
  if (error instanceof InputError) return 400;
  if (error instanceof AuthError) return 401;
  if (error instanceof Conflict) return 409;
  if (error instanceof NotFound) return 404;
  return 500;
}

function callFrom(services: Services, request: Request) {
  const url = new URL(request.url);
  const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const now = services.now();
  const view = services.view();
  return { services, request, url, token, now, view, rules: configuration(view) };
}
type Call = ReturnType<typeof callFrom>;

const keyHolder = (call: Call, kind: string) => whose(call.view, kind, call.token);
const act = (call: Call, type: string, ...args: any[]) => call.services.dispatch(type, args, call.services.now());

function requireKey(call: Call, kind: string) {
  const holder = keyHolder(call, kind);
  if (!holder) throw new AuthError(`precisa da chave ${KEY_HOLDERS[kind]}`);
  return holder;
}

function ownerAct(call: Call, type: string, ...args: any[]) {
  requireKey(call, "owner");
  act(call, type, ...args);
  return json({ ok: true });
}

/** Quando um long poll desiste: pelo tempo que ele pediu para esperar, até o máximo que qualquer um recebe. */
function waitUntil(call: Call) {
  const seconds = Number(call.url.searchParams.get("wait") ?? MAX_WAIT_SECONDS) || 0;
  return call.now + Math.min(Math.max(seconds, 0), MAX_WAIT_SECONDS) * 1000;
}

async function cardAtLink(call: Call, linkToken: string) {
  const { rules, request } = call;
  const { environment } = call.services;
  const card = call.services.card(linkToken);
  const linksInUse = Object.values(rules.channels).some((channel) => channel.links);
  if (!card || !linksInUse) throw new NotFound("não existe este cartão");
  if (call.now - Date.parse(card.created_at) > LINK_LIFETIME) {
    throw new AuthError(
      "este link expirou. Rode agent-autoloop status no computador onde a central está instalada: os cartões ainda sem resposta estão todos lá, e dá para continuar respondendo",
    );
  }
  if (request.method === "GET") return new Response(cardPage(cardView(card, environment)), { headers: PAGE_HEADERS });
  const form = new URLSearchParams(await readText(request));
  const choice = form.has("choice") && { choice: Number(form.get("choice")) };
  act(call, "answer", card.id, { ...choice, text: form.get("text") ?? undefined, by: "link" });
  return new Response(null, { status: 303, headers: { location: call.url.pathname, ...NO_STORE } });
}

async function webhook(call: Call, source: string) {
  if (!call.rules.sources[source]?.adapter) throw new NotFound("esta fonte não aceita Webhook");
  const events = await call.services.adapt(source, call.request.headers, await readText(call.request));
  return json({ events: events.map((event) => act(call, "ingest", source, event)) });
}

async function tell(call: Call) {
  const { rules } = call;
  const source = keyHolder(call, "source");
  const worker = source ? null : keyHolder(call, "worker");
  if (!source && !worker) throw new AuthError("precisa da chave de uma fonte ou de um worker");
  const input = await readJson(call.request);
  // Uma tarefa de outro lugar ou conta algo a você ou pergunta, com uma pergunta exatamente como a de um recibo.
  if (worker && input && typeof input === "object" && "ask" in input) return askAsTask(call, worker, input);
  const expected = source ? ["key", "text"] : ["key", "task", "text"];
  const hasExpected = input && typeof input === "object" && Object.keys(input).sort().join() === expected.join();
  const keyIsValid = typeof input?.key === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(input.key);
  const text = typeof input?.text === "string" ? input.text.trim() : "";
  if (!hasExpected || !keyIsValid || !text || [...text].length > 20_000) {
    throw new InputError(
      "precisa de key e text corretos, um worker ainda precisa escrever task, text tem no máximo 20000 caracteres; para perguntar ao titular, escreva task e ask",
    );
  }
  if (source) {
    return json(act(call, "tell", `source:${source}:${input.key}`, rules.sources[source]?.name ?? source, text));
  }
  const task = taskOf(call, worker!, input.task);
  return json(act(call, "tell", `elsewhere:${task.name}:${input.key}`, task.name, text));
}

function taskOf({ rules, view }: Call, worker: string, name: unknown) {
  const task = rules.elsewhere.find((task) => task.name === name && agentsOf(view, worker).includes(task.to));
  if (!task) throw new AuthError("este worker não tem essa tarefa agendada");
  return task;
}

function askAsTask(call: Call, worker: string, input: Record<string, any>) {
  if (Object.keys(input).sort().join() !== "ask,task" || !isAsk(input.ask)) {
    throw new InputError(
      "para perguntar ao titular escreva só task e ask, e o ask é igual ao de um recibo: title, text e de 2 a 5 options",
    );
  }
  return json(act(call, "ask", taskOf(call, worker, input.task).name, input.ask));
}

async function work(call: Call) {
  const { services, request, url, token } = call;
  const worker = requireKey(call, "worker");
  const claim = url.searchParams.get("claim") ?? "";
  if (!claim || claim.length > 200) throw new InputError("claim identifica este pedido, com no máximo 200 caracteres");
  const running = (url.searchParams.get("running") ?? "").split(",").filter((id) => POSITIVE_ID.test(id));
  act(call, "heartbeat", worker, running.map(Number));
  const until = waitUntil(call);
  for (;;) {
    if (!whose(services.view(), "worker", token)) throw new AuthError("a chave não é mais válida");
    const wantsWork = !request.signal.aborted && url.searchParams.get("capacity") !== "0";
    const job = wantsWork ? act(call, "claimNext", worker, claim) : null;
    const cancel = cancels(services.view(), worker);
    if (job || cancel.length || services.now() >= until || request.signal.aborted) return json({ job, cancel });
    await services.wait(until, request.signal);
  }
}

async function nextCard(call: Call) {
  const { services, request, token } = call;
  const channel = requireKey(call, "channel");
  const until = waitUntil(call);
  act(call, "channelSeen", channel);
  for (;;) {
    if (!whose(services.view(), "channel", token)) throw new AuthError("a chave não é mais válida");
    const card = request.signal.aborted ? null : act(call, "nextCard", channel);
    if (card || services.now() >= until || request.signal.aborted) return json({ card });
    await services.wait(until, request.signal);
  }
}

async function cardAction(call: Call, id: number, action: string) {
  const channel = keyHolder(call, "channel");
  requireKey(call, action === "resolve" || (action === "answer" && !channel) ? "owner" : "channel");
  const given = await readJson(call.request);
  if (action === "resolve") {
    const reason = given?.reason;
    if (typeof reason !== "string" || !reason.trim() || reason.length > 1000) {
      throw new InputError("escreva uma frase com o resultado, com no máximo 1000 caracteres");
    }
    return json({ changed: act(call, "resolve", id, reason.trim(), "o titular") });
  }
  if (action === "answer") {
    const who = channel ? { by: given?.by, ref: given?.ref, channel } : { by: "o titular" };
    return json(act(call, "answer", id, { choice: given?.choice, text: given?.text, ...who }));
  }
  if (!Number.isInteger(given?.version)) throw new InputError("é preciso dizer qual é a versão");
  const ref = typeof given.ref === "string" ? given.ref : null;
  act(call, action, channel, id, given.version, action === "delivered" ? ref : String(given.error ?? ""));
  return json({ ok: true });
}

const CONTROL_FIELDS: Record<string, string[]> = {
  pause: ["reason", "until"],
  resume: [],
  run: ["subject", "reason"],
  replay: ["since"],
};
const CONTROL_INPUTS: Record<string, string> = {
  pause: "pauseRule",
  resume: "resumeRule",
  run: "runRule",
  replay: "replayRule",
};

/** Pausar, retomar, rodar uma regra agora ou reexecutar o que a pausa pulou: ações do titular, mantidas no registro. */
async function control(call: Call, encoded: string, action: string) {
  const holder = requireKey(call, "owner");
  let name: string;
  try {
    name = decodeURIComponent(encoded);
  } catch {
    throw new InputError("o nome não é válido");
  }
  const text = await readText(call.request);
  let given: unknown = {};
  try {
    if (text.trim()) given = JSON.parse(text);
  } catch {
    throw new InputError("não é JSON");
  }
  if (!given || typeof given !== "object" || Array.isArray(given)) throw new InputError("precisa ser um objeto JSON");
  const unknown = Object.keys(given).filter((field) => !CONTROL_FIELDS[action].includes(field));
  if (unknown.length) throw new InputError(`campo não reconhecido: ${unknown.join(", ")}`);
  const type = CONTROL_INPUTS[action];
  if (action === "replay") {
    const { since } = given as Row;
    const from = typeof since === "string" && /(Z|[+-]\d\d:\d\d)$/.test(since) ? Date.parse(since) : NaN;
    if (!Number.isFinite(from))
      throw new InputError("since precisa ser um horário ISO com fuso: a reexecução pega os eventos pulados na pausa");
    // Escolhidos aqui e conferidos de novo ao serem pegos: o que outra reexecução pegou no meio não é pego duas vezes.
    const events = call.services.skipped(name, iso(from), true).events.map((event) => event.id);
    return json(act(call, type, name, events));
  }
  const done = action === "resume" ? act(call, type, name) : act(call, type, name, holder, given);
  if (!done.paused) return json(done);
  // Um agendamento deixa os seus instantes passarem e não guarda eventos. Lida depois que um retomar levantou a pausa,
  // a lista está completa: nada mais pode entrar nela.
  const rule = ruleOf(call.rules, name);
  const skipped = rule && !eventRule(rule) ? null : call.services.skipped(name, done.paused.since);
  return json({ ...done, paused: { ...done.paused, skipped } });
}

function state(call: Call) {
  requireKey(call, "owner");
  const before = call.url.searchParams.get("before");
  if (before !== null && !POSITIVE_ID.test(before)) throw new InputError("o número não é válido");
  return json(call.services.state(call.now, before === null ? undefined : Number(before)));
}

function stream(call: Call) {
  const { request, services, token } = call;
  requireKey(call, "owner");
  const after = call.url.searchParams.get("after") ?? request.headers.get("last-event-id") ?? "0";
  if (!/^\d+$/.test(after) || !Number.isSafeInteger(Number(after)))
    throw new InputError("o número de sequência do registro não é válido");
  const headers = { "content-type": "text/event-stream", ...NO_STORE, "x-accel-buffering": "no" };
  return new Response(services.stream(Number(after), request.signal, token), { headers });
}

async function route(call: Call): Promise<Response> {
  const { request, services, token } = call;
  const { method } = request;
  const path = call.url.pathname;
  if (method === "GET" && path === "/healthz") return json({ ok: true, commit: services.commit });
  // O nome de uma chave é o que foi dado ao `key new`; só precisa continuar sendo um segmento de caminho ao codificar.
  const key = /^\/v1\/keys\/(source|worker|channel|owner)\/([^/]+)$/.exec(path);
  if (method === "DELETE" && key) {
    requireKey(call, "owner");
    let name: string;
    try {
      name = decodeURIComponent(key[2]);
    } catch {
      throw new InputError("o nome da chave não é válido");
    }
    return json({ ok: true, changed: act(call, "removeKey", key[1], name) });
  }
  const link = CARD_LINK.exec(path);
  if (link && ["GET", "POST"].includes(method)) return cardAtLink(call, link[1]);
  const hook = /^\/v1\/in\/([a-z][a-z0-9-]*)$/.exec(path);
  if (method === "POST" && hook) return webhook(call, hook[1]);
  if (method === "POST" && path === "/v1/events") {
    return json(act(call, "ingest", requireKey(call, "source"), await readJson(request)));
  }
  const sent = /^\/v1\/events\/([1-9][0-9]*)$/.exec(path);
  if (method === "GET" && sent) {
    // O evento de outra fonte está tão ausente quanto um nunca enviado: a fonte não sabe quais números já foram usados.
    const found = eventOutcome(call.view, requireKey(call, "source"), Number(sent[1]));
    if (!found) throw new NotFound("não existe este evento");
    return json(found);
  }
  if (method === "POST" && path === "/v1/tell") return tell(call);
  if (method === "GET" && path === "/v1/work") return work(call);
  const [, runPart, action] = /^\/v1\/runs\/([1-9][0-9]*)\/(started|result|cancel|why)$/.exec(path) ?? [];
  const runId = Number(runPart);
  if (method === "GET" && action === "why") {
    requireKey(call, "owner");
    return json(services.why(runId));
  }
  if (method === "POST" && action === "cancel") return ownerAct(call, "cancel", runId);
  if (method === "POST" && action === "started") {
    act(call, "started", runId, token, await readJson(request));
    return json({ ok: true });
  }
  if (method === "POST" && action === "result") return json(act(call, "finish", runId, token, await readJson(request)));
  if (method === "GET" && path === "/v1/cards/next") return nextCard(call);
  const card = /^\/v1\/cards\/([1-9][0-9]*)\/(delivered|failed|answer|resolve)$/.exec(path);
  if (method === "POST" && card) return cardAction(call, Number(card[1]), card[2]);
  const ruleControl = /^\/v1\/rules\/([^/]+)\/(pause|resume|run|replay)$/.exec(path);
  if (method === "POST" && ruleControl) return control(call, ruleControl[1], ruleControl[2]);
  if (method === "GET" && path === "/v1/state") return state(call);
  if (method === "GET" && path === "/v1/stream") return stream(call);
  return json({ error: "não existe esse endereço" }, 404);
}

export function createHandler(services: Services) {
  return async function handle(request: Request): Promise<Response> {
    const call = callFrom(services, request);
    try {
      return await route(call);
    } catch (error) {
      const status = statusOf(error);
      if (status === 500) throw error;
      const message = error instanceof TooLarge ? "a request tem no máximo 1024 KB" : (error as Error).message;
      if (CARD_LINK.test(call.url.pathname)) return new Response(wordsPage(message), { status, headers: PAGE_HEADERS });
      return json({ error: message }, status);
    }
  };
}
