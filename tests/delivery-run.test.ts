// Modos de falha: uma pergunta ao titular com backticks no título ou no texto corta o recibo; um commit curto vindo da verificação
// de saúde não pode ser buscado, então toda mudança precisa de uma publicação e um PR só de documentos nunca termina; uma falha num issue comum é
// encoberta pelo 404 de consultá-lo como PR; um assunto cujo registro de label não pode ser lido faz a varredura inteira falhar; uma rodada
// que falhou grava o erro por cima do status de entrega, então a seguinte esquece que o commit tinha findings e o revisa de novo;
// uma execução obsoleta do Ship exige uma comparação remota que falha, escondendo a publicação bem-sucedida deste merge; uma nova tentativa manual
// reaproveita sua pasta de rascunho e falha porque o origin já existe; fechar um PR com label deixa o status dele pendente;
// um check reiniciado que ainda não tem jobs é contado como erro de execução em vez de ser devolvido com sua causa e aviso;
// sincronizar a main antes de uma reinicialização salva essa reinicialização sob o head antigo, então a rodada seguinte reinicia o mesmo check de novo.
// Nada aqui alcança o GitHub: `gh` é um substituto no início do PATH, e o remote do Git é uma pasta local.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { waitLive } from "../plugins/delivery/delivery.ts";
import { createIO, github, isGitHubHiccup, type DeliveryOptions } from "../plugins/delivery/github.ts";
import { poll } from "../plugins/delivery/poll.ts";
import { settings } from "../plugins/delivery/project.ts";
import { run } from "../plugins/delivery/run.ts";
import { readMessage } from "../worker/contract.ts";

const root = mkdtempSync(join(tmpdir(), "agent-autoloop-delivery-run-"));
after(() => rmSync(root, { recursive: true, force: true }));
const bin = join(root, "bin");
const routes = join(root, "routes.json");
const calls = join(root, "calls.txt");
const statuses = join(root, "statuses.txt");
const bodies = join(root, "bodies.json");
mkdirSync(bin);
writeFileSync(
  join(bin, "gh"),
  `#!${process.execPath}
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const { FAKE_GH_CALLS, FAKE_GH_ROUTES, FAKE_GH_STATUSES, FAKE_GH_BODIES } = process.env;
const args = process.argv.slice(2);
appendFileSync(FAKE_GH_CALLS, args.join(" ") + "\\n");
const answer = JSON.parse(readFileSync(FAKE_GH_ROUTES, "utf8"))[args[1]];
const written = /\\/statuses\\/(\\w+)$/.exec(args[1]);
const asked = /\\/commits\\/(\\w+)\\/status\\?/.exec(args[1]);
const listing = /\\/commits\\/(\\w+)\\/statuses\\?/.exec(args[1]);
const pr = /\\/pulls\\/\\d+$/.test(args[1]);
if (args[1] === "user") { console.log("42"); process.exit(0); }
if (answer?.fail || (answer === undefined && !written && !asked && !listing)) {
  console.error(answer?.fail ?? "gh: Not Found (HTTP 404)");
  process.exit(1);
}
if (answer?.routes && !args.includes("--undo")) {
  const table = JSON.parse(readFileSync(FAKE_GH_ROUTES, "utf8"));
  writeFileSync(FAKE_GH_ROUTES, JSON.stringify({ ...table, ...answer.routes }));
}
if (written) {
  appendFileSync(FAKE_GH_STATUSES, JSON.stringify({ sha: written[1], creator: { id: 42 }, ...JSON.parse(readFileSync(0, "utf8")) }) + "\\n");
  console.log("{}");
} else if (asked) {
  const lines = readFileSync(FAKE_GH_STATUSES, "utf8").split("\\n").filter(Boolean);
  const newestFirst = lines.map((line) => JSON.parse(line)).filter((item) => item.sha === asked[1]).reverse();
  console.log(JSON.stringify({ statuses: newestFirst.filter((item, at) => newestFirst.findIndex((other) => other.context === item.context) === at) }));
} else if (listing && answer === undefined) {
  const rows = readFileSync(FAKE_GH_STATUSES, "utf8").split("\\n").filter(Boolean).map(JSON.parse);
  console.log(JSON.stringify([rows.filter((item) => item.sha === listing[1]).reverse()]));
} else if (pr) {
  const bodies = JSON.parse(readFileSync(FAKE_GH_BODIES, "utf8"));
  if (args.includes("PATCH")) {
    bodies[args[1]] = JSON.parse(readFileSync(0, "utf8")).body;
    writeFileSync(FAKE_GH_BODIES, JSON.stringify(bodies));
  }
  console.log(JSON.stringify({ ...answer, body: bodies[args[1]] ?? answer.body }));
} else {
  console.log(JSON.stringify(args.includes("--slurp") ? [answer] : answer));
}
`,
  { mode: 0o755 },
);
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.FAKE_GH_ROUTES = routes;
process.env.FAKE_GH_CALLS = calls;
process.env.FAKE_GH_STATUSES = statuses;
process.env.FAKE_GH_BODIES = bodies;
writeFileSync(statuses, "");
writeFileSync(bodies, "{}");
/** O que o substituto responde daqui em diante, pelo caminho depois de `gh api`, e uma lista limpa do que lhe foi perguntado. */
const answers = (table: object) => {
  writeFileSync(routes, JSON.stringify(table));
  writeFileSync(calls, "");
};
const issue = (number: number, fields: object = {}) => ({
  number,
  state: "open",
  title: "Precisa de decisão",
  body: "Decida, por favor",
  html_url: `https://github.com/example/app/issues/${number}`,
  labels: [{ name: "ask-owner" }],
  ...fields,
});
const about = (number: number) => ({ events: [{ subject: `example/app#${number}` }] });

test("uma pergunta ao titular com backticks chega inteira à central", async () => {
  const title = "```título";
  answers({
    "repos/example/app/issues/5": issue(5, { title, body: "ainda tem\n```\num bloco de código sem fechamento" }),
  });
  const { problem, receipt } = readMessage(await run("example/app", about(5)));
  assert.equal(problem, undefined);
  const [card] = (receipt as any).ask;
  assert.equal(card.title, title);
  assert.match(card.text, /um bloco de código sem fechamento/);
});

const remote = join(root, "remote");
const gitConfig = join(root, "gitconfig");
writeFileSync(
  gitConfig,
  `[url "file://${remote}"]\n\tinsteadOf = https://github.com/example/app.git\n[user]\n\tname = t\n\temail = t@t\n`,
);
process.env.GIT_CONFIG_GLOBAL = gitConfig;
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: remote, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function publish(name: string, words: string) {
  writeFileSync(join(remote, name), words);
  git("add", "-A");
  git("commit", "-q", "-m", words);
  return git("rev-parse", "HEAD");
}
mkdirSync(join(remote, "docs"), { recursive: true });
git("init", "-q", "-b", "main");
writeFileSync(join(remote, "app.ts"), "1");
writeFileSync(join(remote, "AGENTS.md"), "## Pontos de revisão\npontos\n");
const live = publish("docs/a.md", "first");
const docsOnly = publish("docs/a.md", "second");
const code = publish("app.ts", "2");
const internal = ["docs/*.md"];
const ioIn = (name: string, options?: DeliveryOptions) => {
  const folder = join(root, name);
  mkdirSync(folder);
  return createIO("example/app", folder, options);
};

test("um commit curto vindo da verificação de saúde é completado antes da comparação", async () => {
  const short = live.slice(0, 7);
  answers({ [`repos/example/app/commits/${short}`]: { sha: live } });
  const io = ioIn("short");
  assert.equal(await io.releaseRequired(short, docsOnly, internal), false);
  assert.equal(await io.releaseRequired(short, code, internal), true);
});
test("um commit completo é comparado como está, sem consultar o GitHub", async () => {
  answers({});
  const io = ioIn("full");
  assert.equal(await io.releaseRequired(live, docsOnly, internal), false);
  assert.ok(!readFileSync(calls, "utf8").includes("commits/"));
});
test("um commit curto que o GitHub não conhece significa uma publicação", async () => {
  answers({});
  assert.equal(await ioIn("unknown").releaseRequired("abcdef0", docsOnly, internal), true);
});

test("o Ship usa a ancestralidade local para execuções mais antigas e para a versão saudável curta", async () => {
  answers({
    "repos/example/app/actions/workflows/ship.yml/runs?branch=main&event=push&per_page=100": {
      workflow_runs: [
        { id: 2, event: "push", head_sha: docsOnly, status: "completed", conclusion: "success" },
        { id: 1, event: "push", head_sha: live, status: "completed", conclusion: "success" },
      ],
    },
    [`repos/example/app/compare/${docsOnly}...${live}`]: { fail: "gh: HTTP 502" },
  });
  const io = ioIn("ship-history");
  io.live = async () => ({ sha: live.slice(0, 7), release: "live-before" });
  const config = settings({
    repo: "example/app",
    internal,
    review: { points: "AGENTS.md" },
    health: { url: "https://example.invalid/health", field: "commit", pattern: "(?<sha>[0-9a-f]{7,40})" },
  });
  assert.deepEqual(await waitLive(docsOnly, config, io), { phase: "docs_only", ship: 2, release: "live-before" });
  assert.doesNotMatch(readFileSync(calls, "utf8"), /compare\/|commits\//);
});

test("uma nova tentativa manual consegue buscar a main na sua pasta de rascunho já existente", async () => {
  const folder = join(root, "retry-objects");
  const first = createIO("example/app", folder);
  await first.prepareShip?.();
  const retry = createIO("example/app", folder);
  await retry.prepareShip?.();
  assert.equal(await retry.contains(live, docsOnly), true);
});

test("o toolkit confia apenas num commit na main que contenha suas mudanças de ferramenta mais recentes", async () => {
  const installedFile = `repos/example/app/contents/ops/delivery/kit.json?ref=${code}`;
  const checks = (installed: string, onMain: string, current: string) => ({
    [installedFile]: { content: Buffer.from(JSON.stringify({ kit: installed })).toString("base64") },
    "repos/example/tools/git/ref/heads/main": { object: { sha: code } },
    [`repos/example/tools/commits?sha=${code}&path=delivery&per_page=1`]: [{ sha: docsOnly }],
    [`repos/example/tools/compare/${installed}...${code}`]: { status: onMain },
    [`repos/example/tools/compare/${docsOnly}...${installed}`]: { status: current },
  });
  const io = ioIn("kit", { toolkit: "example/tools" });
  answers(checks(docsOnly, "ahead", "identical"));
  assert.equal(await io.verifyTools?.(code), null);
  answers(checks(live, "ahead", "behind"));
  assert.match((await io.verifyTools?.(code)) ?? "", /não é a versão mais recente da main/);
  answers(checks(live, "diverged", "ahead"));
  assert.match((await io.verifyTools?.(code)) ?? "", /não é a versão mais recente da main/);
  assert.equal(ioIn("own-kit", { toolkit: "example/app" }).verifyTools, undefined);
});

test("falhas 5xx e de GraphQL do próprio GitHub mantêm sua classificação através da CLI", async () => {
  const api = github("example/app");
  for (const failure of ["gh: something failed (HTTP 502)", "Something went wrong while executing your query"]) {
    answers({ "repos/example/app/pulls/1": { fail: failure } });
    await assert.rejects(() => api("pulls/1"), isGitHubHiccup);
  }
  answers({ "repos/example/app/pulls/1": { fail: "secondary rate limit (HTTP 403)" } });
  await assert.rejects(
    () => api("pulls/1"),
    (error) => !isGitHubHiccup(error),
  );
});

test("draft e ready usam as transições de PR da CLI do GitHub", async () => {
  answers({ ready: {} });
  const api = github("example/app");
  await api("pulls/8/draft", {}, "POST");
  await api("pulls/8/ready", {}, "POST");
  assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), [
    "pr ready 8 --repo example/app --undo",
    "pr ready 8 --repo example/app",
  ]);
});

test("uma falha num issue comum é reportada como aconteceu", async () => {
  answers({
    "repos/example/app/issues/5": issue(5),
    "repos/example/app/issues/5/labels/ask-owner": { fail: "permission denied" },
  });
  const answered = { ...about(5), answers: [{ text: "Resolvido" }] };
  await assert.rejects(() => run("example/app", answered), /permission denied/);
  assert.ok(!readFileSync(calls, "utf8").includes("pulls/5"));
});
test("uma entrega que falhou ainda marca o commit em que parou", async () => {
  const fork = { number: 7, state: "open", labels: [{ name: "deliver" }], base: { ref: "main" } };
  const pr = { ...fork, head: { sha: "abc", repo: { full_name: "fork/app" } } };
  answers({
    "repos/example/app/issues/7": { ...fork, pull_request: {} },
    "repos/example/app/pulls/7": pr,
    "repos/example/app/statuses/abc": {},
  });
  await assert.rejects(() => run("example/app", about(7)), /deste repositório/);
  assert.match(readFileSync(calls, "utf8"), /statuses\/abc --method POST/);
});
test("um assunto cujo registro de label não pode ser lido não segura os outros", async () => {
  answers({
    "repos/example/app/issues?state=all&labels=deliver&per_page=100": [
      { number: 1, pull_request: {} },
      { number: 2, pull_request: {} },
    ],
    "repos/example/app/issues?state=all&labels=ask-owner&per_page=100": [],
    "repos/example/app/issues/1/events?per_page=100": [],
    "repos/example/app/issues/2/events?per_page=100": [{ event: "labeled", id: 9, label: { name: "deliver" } }],
    "repos/example/app/pulls/1": { state: "open", head: { sha: "aaa" } },
    "repos/example/app/pulls/2": { state: "open", head: { sha: "bbb" } },
  });
  const events = await poll("example/app");
  assert.deepEqual(
    events.map((event) => event.id),
    ["example/app#1:0:aaa", "example/app#2:9:bbb"],
  );
});

const reviewer = join(root, "reviewer.mjs");
const plan = join(root, "plan.json");
const reviews = join(root, "reviews.txt");
writeFileSync(
  reviewer,
  `import fs from "node:fs";
for await (const _ of process.stdin);
fs.appendFileSync(${JSON.stringify(reviews)}, "x");
const { findings } = JSON.parse(fs.readFileSync(${JSON.stringify(plan)}, "utf8"));
console.log(JSON.stringify({ findings }));
`,
);
/** O que o revisor substituto encontra. */
const reviewFinds = (findings: object[]) => writeFileSync(plan, JSON.stringify({ findings }));
const timesReviewed = () => readFileSync(reviews, "utf8").length;
const lastStatus = (context: string) =>
  readFileSync(statuses, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((item) => item.context === context)
    .at(-1);
const startOver = () => {
  writeFileSync(statuses, "");
  writeFileSync(reviews, "");
  writeFileSync(bodies, "{}");
};
const settingsPath = `repos/example/app/contents/ops/delivery.json?ref=${live}`;
const settingsFile = {
  content: Buffer.from(
    JSON.stringify({
      repo: "example/app",
      internal,
      review: { points: "AGENTS.md", status: "my-review", command: [process.execPath, reviewer] },
      health: { url: "http://127.0.0.1:1/health", field: "commit", pattern: "(?P<sha>[0-9a-f]{40})" },
    }),
  ).toString("base64"),
};
const openPr = {
  number: 8,
  state: "open",
  draft: false,
  merged_at: null,
  merge_commit_sha: null,
  auto_merge: null,
  labels: [{ name: "deliver" }],
  head: { sha: code, repo: { full_name: "example/app" } },
  base: { ref: "main" },
  user: { login: "owner" },
};
/** O PR 8 do remote local, a caminho da main no primeiro commit. */
const delivering = (pr: object) => ({
  "repos/example/app/issues/8": { number: 8, labels: [{ name: "deliver" }], pull_request: {} },
  "repos/example/app/pulls/8": pr,
  "repos/example/app/git/ref/heads/main": { object: { sha: live } },
  [settingsPath]: settingsFile,
  [`repos/example/app/compare/${live}...${code}`]: { status: "ahead" },
});
test("um handoff fechado sem merge registra a falha antes de limpar suas labels de fila", async () => {
  startOver();
  answers({ ...delivering({ ...openPr, state: "closed" }), edit: {} });
  const phases: string[] = [];
  const message = await run("example/app", about(8), true, {
    notifyCommand: join(root, "must-not-notify"),
    report: (phase) => {
      phases.push(phase);
    },
  });
  assert.match(message, /fechado/);
  assert.equal(lastStatus("delivery")?.state, "failure");
  assert.match(lastStatus("delivery").description, /fechado/);
  assert.deepEqual(phases, ["returned"]);
  const called = readFileSync(calls, "utf8");
  assert.ok(called.indexOf(`/statuses/${code}`) < called.indexOf("pr edit"));
});

test("um check reiniciado depois de sincronizar a main é salvo sob o head sincronizado quando o GitHub falha", async (t) => {
  startOver();
  reviewFinds([]);
  t.mock.method(Date, "now", () => Date.parse("2026-11-12T00:00:00Z"));
  const checks = `repos/example/app/actions/workflows/check.yml/runs?head_sha=${code}&event=pull_request&per_page=100`;
  const queued = { head_sha: code, event: "pull_request", status: "queued", created_at: "2026-11-11T00:00:00Z" };
  answers({
    ...delivering({ ...openPr, head: { ...openPr.head, sha: docsOnly } }),
    "repos/example/app/git/ref/heads/main": { object: { sha: code } },
    [`repos/example/app/contents/ops/delivery.json?ref=${code}`]: settingsFile,
    [`repos/example/app/compare/${code}...${docsOnly}`]: { status: "behind" },
    [`repos/example/app/compare/${docsOnly}...${code}`]: { status: "ahead" },
    "repos/example/app/pulls/8/update-branch": { routes: { "repos/example/app/pulls/8": openPr } },
    [checks]: { workflow_runs: [{ ...queued, id: 10 }] },
    "repos/example/app/actions/runs/10/jobs?filter=latest&per_page=100": { jobs: [] },
    ready: { routes: { [checks]: { workflow_runs: [{ ...queued, id: 12 }] } } },
    "repos/example/app/actions/runs/12/jobs?filter=latest&per_page=100": { fail: "gh: HTTP 502" },
  });
  const message = readMessage(
    await run("example/app", about(8), true, { notifyCommand: join(root, "must-not-notify") }),
  );
  assert.equal(message.problem, undefined);
  const [retry] = (message.receipt as any).later;
  assert.deepEqual(JSON.parse(retry.about), { head: code, github: 1, execution: 0, checkAfter: 10 });
  assert.deepEqual(
    readFileSync(calls, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("pr ready")),
    ["pr ready 8 --repo example/app --undo", "pr ready 8 --repo example/app"],
  );
});

test("um check ainda travado depois de uma reinicialização salva devolve a causa exata e o aviso, sem nova tentativa por erro", async (t) => {
  startOver();
  reviewFinds([]);
  const reason =
    "O GitHub aceitou o check, mas ele nunca começou (provável incidente); já foi reacionado e segue parado. Reentregue quando o GitHub voltar.";
  answers({
    ...delivering(openPr),
    [`repos/example/app/actions/workflows/check.yml/runs?head_sha=${code}&event=pull_request&per_page=100`]: {
      workflow_runs: [
        { id: 12, head_sha: code, event: "pull_request", status: "queued", created_at: "2026-11-11T00:00:00Z" },
      ],
    },
    "repos/example/app/actions/runs/12/jobs?filter=latest&per_page=100": { jobs: [] },
    edit: {},
  });
  const notices = join(root, "stalled-notices.txt");
  const notify = join(root, "notify-stalled.mjs");
  writeFileSync(notices, "");
  writeFileSync(
    notify,
    `#!${process.execPath}
import { appendFileSync } from "node:fs";
let input = "";
for await (const chunk of process.stdin) input += chunk;
appendFileSync(${JSON.stringify(notices)}, input + "\\n");
`,
    { mode: 0o755 },
  );
  const started = Date.parse("2026-11-12T00:00:00Z");
  let clockReads = 0;
  // O caminho antigo de espera precisa expirar imediatamente para que esta regressão não possa dormir por meia hora.
  t.mock.method(Date, "now", () => started + (clockReads++ === 0 ? 0 : 31 * 60_000));
  const phases: string[] = [];
  const message = await run(
    "example/app",
    {
      ...about(8),
      timers: [
        { key: "delivery-retry", about: JSON.stringify({ head: code, github: 0, execution: 0, checkAfter: 11 }) },
      ],
    },
    true,
    {
      notifyCommand: notify,
      report: (phase) => {
        phases.push(phase);
      },
    },
  );
  assert.equal(message, `entrega devolvida: ${reason}`);
  assert.equal(lastStatus("delivery").state, "failure");
  assert.equal(lastStatus("delivery").description, reason);
  assert.equal(phases.at(-1), "returned");
  assert.ok(!phases.includes("retrying"));
  const sent = readFileSync(notices, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(sent.length, 1);
  assert.ok(sent[0].text.includes(reason));
  const called = readFileSync(calls, "utf8");
  assert.match(called, /pr edit 8 --repo example\/app --remove-label deliver,deliver-review/);
  assert.doesNotMatch(called, /pr ready/);
});
const dataLoss = [{ title: "Há perda de dados", text: "Corrija primeiro" }];

test("uma rodada que falhou no meio não abre um commit com findings para outra revisão", async () => {
  startOver();
  reviewFinds(dataLoss);
  answers(delivering(openPr));
  const first = readMessage(await run("example/app", about(8), true));
  assert.equal((first.receipt as any).notice.length, 1);
  assert.equal(timesReviewed(), 1);
  // As configurações não podem ser lidas desta vez, e a falha vai para o status de entrega por cima do que a revisão escreveu ali.
  answers({ ...delivering(openPr), [settingsPath]: { fail: "HTTP 502" } });
  await assert.rejects(() => run("example/app", about(8), true), /HTTP 502/);
  assert.doesNotMatch(lastStatus("delivery").description, /A revisão encontrou problemas/);
  // Uma revisão agora deixaria o problema passar, e nada mais ficaria entre ele e o merge.
  reviewFinds([]);
  answers(delivering(openPr));
  const third = await run("example/app", about(8), true).catch((error) => error.message);
  assert.equal(timesReviewed(), 1);
  assert.equal(lastStatus("my-review").state, "failure");
  assert.match(third, /O item 1 da revisão do Codex ainda não foi tratado/);
});

const merged = { ...openPr, state: "closed", merged_at: "now", merge_commit_sha: code };
const failedShip = {
  ...delivering(merged),
  "repos/example/app/actions/workflows/ship.yml/runs?branch=main&event=push&per_page=100": {
    workflow_runs: [{ id: 1, head_sha: code, event: "push", status: "completed", conclusion: "failure" }],
  },
};
test("uma publicação que falhou é uma falha simples", async () => {
  startOver();
  answers(failedShip);
  await assert.rejects(() => run("example/app", about(8), true), /publicação não passou/);
  assert.equal(lastStatus("delivery").state, "failure");
  assert.equal(timesReviewed(), 0);
});
