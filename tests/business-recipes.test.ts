// Modos de falha: uma página de erro ou um redirecionamento com HTTP 200 é chamado de saudável; uma indisponibilidade que
// continua acorda o modelo ou notifica de novo; a recuperação encerra um cartão sem relação; o Feishu é lido como o bot,
// páginas ou campos selecionados se perdem, um relatório sem relação é incluído, as credenciais falham mas um snapshot
// antigo é resumido, ou texto de relatório vaza para as notificações. O e-mail é lido como o bot, o corpo de um remetente
// que o usuário pediu para ignorar ainda é lido, um corpo longo é mantido inteiro ou é cortado aquém do que o leitor
// recebe, uma caixa vazia acorda o modelo, ou uma caixa que devolveu apenas alguns corpos é salva como lida.
// Uma página de remetentes que o usuário pediu para ignorar preenche o limite e esconde o e-mail atrás dela, de modo que
// uma caixa com e-mail é lida como se não houvesse nada a ler; ou páginas ficam sem varredura, pelo limite ou pelo teto, e
// o briefing ainda diz que leu todas.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { probe, receipt } from "../examples/recipes/website-watch/check.ts";
import { readMessage, resultFrom } from "../worker/contract.ts";

const scratch = mkdtempSync(join(tmpdir(), "agent-autoloop-business-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const target = { id: "site", name: "Site de exemplo", url: "https://example.com/health", contains: '"ok":true' };
const empty = { events: [{ id: "tick-1" }], open: [] };

test("a verificação do site olha status e corpo sem seguir redirecionamentos, e registra falhas de transporte", async () => {
  const response = (status: number, body: string) =>
    (async (_url, options) => {
      assert.equal(options?.redirect, "manual");
      return new Response(body, { status });
    }) as typeof fetch;
  assert.equal((await probe(target, response(200, '{"ok":true}'))).ok, true);
  for (const [status, body] of [
    [200, "faça login para continuar"],
    [503, '{"ok":true}'],
    [302, "redirecionamento"],
  ] as const) {
    assert.equal((await probe(target, response(status, body))).ok, false);
  }
  assert.equal(
    (
      await probe(target, async () => {
        throw new TypeError("network");
      })
    ).ok,
    false,
  );
});

test("a indisponibilidade do site acorda uma vez enquanto o cartão está aberto, e a recuperação encerra só o cartão daquele site", () => {
  const first = receipt(target, { ok: false, reason: "respondeu 503" }, empty);
  assert.equal(first.events?.[0].type, "site.down");
  assert.equal(first.notice?.length, 1);
  const pending = {
    ...empty,
    // O cartão sem relação vem primeiro: um recibo que resolve qualquer cartão que esteja primeiro, em vez daquele cujo
    // título nomeia este site, encerra o cartão errado.
    open: [
      { card: 8, title: "Falha em outro site" },
      { card: 7, title: first.notice![0].title },
    ],
  };
  assert.deepEqual(receipt(target, { ok: false, reason: "respondeu 503" }, pending), {});
  const recovered = receipt(target, { ok: true, reason: "status e conteúdo essencial verificados" }, pending);
  assert.deepEqual(
    recovered.resolve?.map((r) => r.card),
    [7],
  );
  assert.equal(recovered.events?.[0].type, "site.recovered");
  assert.deepEqual(receipt(target, { ok: true, reason: "normal" }, empty), {});
});

test("uma URL de saúde com caracteres não ASCII continua sendo um link de evento válido no recibo do worker", () => {
  const result = receipt(
    { ...target, url: "https://exemplosaúde.teste/status" },
    { ok: false, reason: "falha de conexão" },
    empty,
  );
  const parsed = resultFrom(readMessage(`Verifiquei\n\`\`\`agent-autoloop\n${JSON.stringify(result)}\n\`\`\``), {});
  assert.equal(parsed.problem, undefined);
  assert.equal(parsed.result.events![0].link, new URL("https://exemplosaúde.teste/status").href);
});

function collect(mode = "ok") {
  const dir = mkdtempSync(join(scratch, "brief-"));
  const cli = join(dir, "lark-cli");
  writeFileSync(
    cli,
    `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync('calls.jsonl', JSON.stringify(args) + '\\n');
if (${JSON.stringify(mode)} === 'auth') {
  console.error(JSON.stringify({ok:false,error:{type:'authorization',message:'secret must not be copied'}})); process.exit(1);
}
let data;
if (args[0] === 'api') {
 const body = JSON.parse(args[args.indexOf('--data')+1]);
 const task = {task_id:'report-1',rule_name:'Relatório semanal de trabalho',from_user_id:'ou_demo',commit_time:body.commit_start_time+60,form_contents:[{field_name:'Progresso da semana',field_value:'texto confidencial'}]};
 data = {items:[task,{...task,task_id:'outside',from_user_id:'ou_other'},{...task,task_id:'wrong-rule',rule_name:'Relatório livre'}],has_more:false};
} else {
 const offset = Number(args[args.indexOf('--offset')+1]);
 const file = args[args.indexOf('--output')+1];
 fs.writeFileSync(file, JSON.stringify({record_id:'record-'+offset,Projeto:'projeto de demonstração',Status:'em andamento'})+'\\n');
 data = {records_count:1,has_more:offset===0,next_offset:offset+1,rev:'1'};
 fs.writeFileSync(file.replace(/\\.ndjson$/, '.manifest.json'), JSON.stringify(data));
}
console.log(JSON.stringify({ok:true,identity:'user',data}));
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(dir, "sources.json"),
    JSON.stringify({
      reportRule: "Relatório semanal de trabalho",
      reportUsers: ["ou_demo"],
      tables: [
        {
          name: "Tabela de projetos",
          baseToken: "demo",
          tableId: "tbl_demo",
          fields: ["Projeto", "Status"],
          url: "https://example.com/projects",
        },
      ],
    }),
  );
  writeFileSync(join(dir, "context.json"), JSON.stringify({ answers: [], open: [], events: [] }));
  writeFileSync(join(dir, "weekly-input.json"), '{"id":"old","reports":["old data"]}');
  const run = spawnSync(
    process.execPath,
    [join(import.meta.dirname, "../examples/recipes/feishu-brief/collect.ts"), "sources.json"],
    {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, AGENT_AUTOLOOP_CONTEXT: join(dir, "context.json") },
    },
  );
  return { dir, run, parsed: resultFrom(readMessage(run.stdout), {}) };
}

test("a coleta do Feishu usa o leitor, filtra relatórios e campos, e consome todas as páginas da tabela", () => {
  const { dir, run, parsed } = collect();
  assert.equal(run.status, 0, run.stderr);
  assert.equal(parsed.problem, undefined);
  assert.equal(parsed.result.events?.[0].type, "brief.ready");
  assert.doesNotMatch(run.stdout, /texto confidencial|projeto de demonstração/);
  const snapshot = JSON.parse(readFileSync(join(dir, "weekly-input.json"), "utf8"));
  assert.deepEqual(
    snapshot.reports.map((r: { task_id: string }) => r.task_id),
    ["report-1"],
  );
  assert.equal(snapshot.tables[0].records.length, 2);
  const calls: string[][] = readFileSync(join(dir, "calls.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(calls.every((args) => args[args.indexOf("--as") + 1] === "user"));
  const baseCalls = calls.filter((args) => args[0] === "base");
  assert.equal(baseCalls.length, 2);
  assert.ok(baseCalls.every((args) => args.includes("--field-id") && args.includes("Status")));
  assert.equal(snapshot.id, parsed.result.events![0].id);
});

test("uma falha de autorização no Feishu pergunta uma vez e nunca publica o snapshot antigo nem detalhes do CLI", () => {
  const { dir, run, parsed } = collect("auth");
  assert.equal(run.status, 0, run.stderr);
  assert.equal(parsed.problem, undefined);
  assert.equal(parsed.result.outcome, "done");
  assert.equal(parsed.result.ask?.length, 1);
  assert.equal(parsed.result.events, undefined);
  assert.doesNotMatch(run.stdout + run.stderr, /secret must not|old data/);
  assert.equal(JSON.parse(readFileSync(join(dir, "weekly-input.json"), "utf8")).id, "old");
});

function triage(mode = "ok") {
  const dir = mkdtempSync(join(scratch, "inbox-"));
  const cli = join(dir, "lark-cli");
  const summaries = [
    {
      message_id: "m-budget",
      thread_id: "t-budget",
      subject: "Confirmação do orçamento trimestral",
      head_from: { name: "Fulana de Tal", mail_address: "fulana@example.com" },
      folder_id: "INBOX",
      label_ids: ["UNREAD"],
      date_formatted: "2026-11-07 09:12",
      body_preview: "A planilha do orçamento está no anexo, por favor confirme",
    },
    {
      message_id: "m-bulk",
      thread_id: "t-bulk",
      subject: "Novidades do produto desta semana",
      head_from: { name: "Robô de notificações", mail_address: "noreply@example.com" },
      folder_id: "INBOX",
      date_formatted: "2026-11-07 08:00",
      body_preview: "Não é preciso responder",
    },
    {
      message_id: "m-long",
      thread_id: "t-long",
      subject: "Uma instrução muito longa",
      head_from: { name: "Beltrano da Silva", mail_address: "beltrano@example.com" },
      folder_id: "INBOX",
      date_formatted: "2026-11-06 22:41",
      body_preview: "Corpo muito longo",
    },
  ];
  const bodies = { "m-budget": "corpo confidencial: orçamento de quarenta e dois mil", "m-long": "z".repeat(3000) };
  writeFileSync(
    cli,
    `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync('calls.jsonl', JSON.stringify(args) + '\\n');
const mode = ${JSON.stringify(mode)};
if (mode === 'auth') {
  console.error(JSON.stringify({ ok: false, error: { type: 'authorization', message: 'secret must not be copied' } }));
  process.exit(1);
}
const summaries = ${JSON.stringify(summaries)};
const bodies = ${JSON.stringify(bodies)};
const notify = Array.from({ length: 30 }, (_, i) => ({
  message_id: 'n' + i, thread_id: 't-n' + i, subject: 'Novidades do produto desta semana', folder_id: 'INBOX',
  head_from: { name: 'Robô de notificações', mail_address: 'noreply@example.com' },
  date_formatted: '2026-11-09 08:00', body_preview: 'Não é preciso responder',
}));
const wanted = Array.from({ length: 30 }, (_, i) => ({
  message_id: 'w' + i, thread_id: 't-w' + i, subject: 'Confirme o cronograma', folder_id: 'INBOX',
  head_from: { name: 'Sicrano Souza', mail_address: 'sicrano@example.com' },
  date_formatted: '2026-11-09 09:00', body_preview: 'Por favor, responda',
}));
let data;
if (args[1] === '+triage' && mode === 'full') {
  data = { messages: wanted, has_more: true, page_token: 'list:P2' };
} else if (args[1] === '+triage') {
  const token = args.includes('--page-token') ? args[args.indexOf('--page-token') + 1] : '';
  const second = {
    paged: { messages: [summaries[0]], has_more: false, page_token: '' },
    'paged-endless': { messages: notify, has_more: true, page_token: 'list:P2' },
    'paged-empty': { messages: [], has_more: false, page_token: '' },
  };
  const more = { messages: notify, has_more: true, page_token: 'list:P2' };
  data = second[mode] ? (token === 'list:P2' ? second[mode] : more) : { messages: mode === 'empty' ? [] : summaries };
} else {
  const ids = args[args.indexOf('--message-ids') + 1].split(',');
  data = {
    messages: ids.map((id) => ({ message_id: id, body_plain_text: bodies[id] ?? '' })),
    total: ids.length,
    unavailable_message_ids: mode === 'partial' ? [ids[0]] : [],
  };
}
console.log(JSON.stringify({ ok: true, identity: 'user', data }));
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(dir, "sources.json"),
    JSON.stringify({
      folderId: "INBOX",
      onlyUnread: true,
      lookbackHours: 24,
      maxMessages: 30,
      bodyChars: 1200,
      skipSenders: ["noreply@example.com"],
    }),
  );
  writeFileSync(join(dir, "context.json"), JSON.stringify({ answers: [], open: [], events: [] }));
  writeFileSync(join(dir, "inbox-input.json"), '{"id":"old","messages":["old data"]}');
  const run = spawnSync(
    process.execPath,
    [join(import.meta.dirname, "../examples/recipes/inbox-triage/collect.ts"), "sources.json"],
    {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, AGENT_AUTOLOOP_CONTEXT: join(dir, "context.json") },
    },
  );
  return { dir, run, parsed: resultFrom(readMessage(run.stdout), {}) };
}

test("o e-mail é lido como o usuário, o corpo de um remetente ignorado nunca é lido, e um corpo longo é cortado num tamanho declarado", () => {
  const { dir, run, parsed } = triage();
  assert.equal(run.status, 0, run.stderr);
  assert.equal(parsed.problem, undefined);
  assert.equal(parsed.result.events?.[0].type, "inbox.ready");
  assert.doesNotMatch(run.stdout, /corpo confidencial|z{100}/, "o corpo do e-mail não vai para o log");
  const snapshot = JSON.parse(readFileSync(join(dir, "inbox-input.json"), "utf8"));
  assert.deepEqual(
    snapshot.messages.map((m: { message_id: string }) => m.message_id),
    ["m-budget", "m-long"],
  );
  assert.equal(snapshot.messages[0].body, "corpo confidencial: orçamento de quarenta e dois mil");
  assert.equal([...snapshot.messages[1].body].length, 1200);
  assert.equal(snapshot.messages[1].truncated, true);
  assert.equal(snapshot.messages[0].truncated, false);
  assert.equal(snapshot.id, parsed.result.events![0].id);
  const calls: string[][] = readFileSync(join(dir, "calls.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(calls.every((args) => args[args.indexOf("--as") + 1] === "user"));
  const read = calls.find((args) => args.includes("--message-ids"))!;
  assert.deepEqual(read[read.indexOf("--message-ids") + 1].split(","), ["m-budget", "m-long"]);
  assert.ok(read.includes("--html=false"), "só o corpo em texto puro, sem buscar HTML");
  const filter = calls.find((args) => args.includes("--filter"))!;
  assert.equal(JSON.parse(filter[filter.indexOf("--filter") + 1]).folder_id, "INBOX");
});

test("remetentes ignorados na primeira página não consomem o limite, então o e-mail atrás deles é lido, e nenhum deles custa um corpo", () => {
  const { dir, run, parsed } = triage("paged");
  assert.equal(run.status, 0, run.stderr);
  assert.equal(parsed.problem, undefined);
  assert.equal(parsed.result.events?.[0].type, "inbox.ready");
  const snapshot = JSON.parse(readFileSync(join(dir, "inbox-input.json"), "utf8"));
  assert.deepEqual(
    snapshot.messages.map((m: { message_id: string }) => m.message_id),
    ["m-budget"],
    "a primeira página é toda de remetentes ignorados; a mensagem seguinte, que precisa de resposta, não pode ser empurrada para fora",
  );
  assert.equal(
    snapshot.scanned.complete,
    true,
    "a leitura foi até o fim da janela; a lista precisa dizer que este lote é tudo",
  );
  const calls: string[][] = readFileSync(join(dir, "calls.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const pages = calls.filter((args) => args[1] === "+triage");
  assert.equal(pages.length, 2, "havendo next page, é preciso continuar paginando");
  assert.equal(pages[1][pages[1].indexOf("--page-token") + 1], "list:P2");
  assert.deepEqual(
    calls.filter((args) => args.includes("--message-ids")).map((args) => args[args.indexOf("--message-ids") + 1]),
    ["m-budget"],
    "o corpo só é buscado para as mensagens mantidas; nenhuma dos remetentes ignorados",
  );
});

test("páginas que se esgotam sem nada mantido dizem que não há o que ler, e ainda assim não pedem nenhum corpo", () => {
  const { dir, run, parsed } = triage("paged-empty");
  assert.equal(run.status, 0, run.stderr);
  assert.equal(parsed.result.outcome, "nothing");
  assert.equal(parsed.result.events, undefined);
  assert.doesNotMatch(readFileSync(join(dir, "calls.jsonl"), "utf8"), /--message-ids/);
  const calls: string[][] = readFileSync(join(dir, "calls.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(
    calls.filter((args) => args[1] === "+triage").length,
    2,
    "só se pode dizer que não há nada depois de paginar até não dar mais",
  );
  assert.equal(
    JSON.parse(readFileSync(join(dir, "inbox-input.json"), "utf8")).id,
    "old",
    "só é realmente vazio quando a leitura chega ao fim da janela; o snapshot antigo fica intacto",
  );
});

test("uma leitura que para enquanto restam páginas diz que houve e-mail não varrido, em vez de afirmar que não havia nada", () => {
  const { dir, run, parsed } = triage("paged-endless");
  assert.equal(run.status, 0, run.stderr);
  assert.equal(parsed.result.outcome, "done", "não ler tudo não é nada a fazer");
  assert.doesNotMatch(run.stdout, /não há e-mails para ler/);
  const snapshot = JSON.parse(readFileSync(join(dir, "inbox-input.json"), "utf8"));
  assert.equal(snapshot.scanned.complete, false, "a lista precisa dizer que há páginas não vistas");
  assert.ok(snapshot.scanned.summaries > 0);
  assert.match(
    parsed.result.events?.[0].summary ?? "",
    /não lidas/,
    "o recibo também precisa dizer que a leitura não foi completa",
  );
  assert.doesNotMatch(
    readFileSync(join(dir, "calls.jsonl"), "utf8"),
    /--message-ids/,
    "sem nenhuma mensagem mantida, nenhum corpo é buscado",
  );
});

test("uma leitura que preenche o limite enquanto a listagem tem mais diz que houve e-mail deixado sem ler", () => {
  const { dir, run, parsed } = triage("full");
  assert.equal(run.status, 0, run.stderr);
  const snapshot = JSON.parse(readFileSync(join(dir, "inbox-input.json"), "utf8"));
  assert.equal(snapshot.messages.length, 30);
  assert.equal(
    snapshot.scanned.complete,
    false,
    "com o limite cheio e ainda havendo mensagens depois, não se pode dizer que tudo foi lido",
  );
  assert.match(
    parsed.result.events?.[0].summary ?? "",
    /não lidas/,
    "o recibo também precisa dizer que a leitura não foi completa",
  );
});

test("uma caixa vazia diz isso, mantém o snapshot antigo e não pede nenhum corpo à caixa de entrada", () => {
  const { dir, run, parsed } = triage("empty");
  assert.equal(run.status, 0, run.stderr);
  assert.equal(parsed.result.outcome, "nothing");
  assert.equal(parsed.result.events, undefined);
  assert.doesNotMatch(readFileSync(join(dir, "calls.jsonl"), "utf8"), /--message-ids/);
  assert.equal(JSON.parse(readFileSync(join(dir, "inbox-input.json"), "utf8")).id, "old");
});

test("uma caixa de entrada que devolveu apenas alguns corpos não é salva como um snapshot completo", () => {
  const { dir, run } = triage("partial");
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /não devolveu o corpo de algumas mensagens/);
  assert.equal(JSON.parse(readFileSync(join(dir, "inbox-input.json"), "utf8")).id, "old");
});

test("uma falha de autorização do e-mail pergunta uma vez e mantém o snapshot anterior", () => {
  const { dir, run, parsed } = triage("auth");
  assert.equal(run.status, 0, run.stderr);
  assert.equal(parsed.result.outcome, "done");
  assert.equal(parsed.result.ask?.length, 1);
  assert.equal(parsed.result.events, undefined);
  assert.doesNotMatch(run.stdout + run.stderr, /secret must not|old data/);
  assert.equal(JSON.parse(readFileSync(join(dir, "inbox-input.json"), "utf8")).id, "old");
});
