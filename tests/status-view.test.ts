// Como o `agent-autoloop status` dispõe o estado para uma pessoa. Modos de falha: códigos de cor chegam a um pipe, a um arquivo
// ou a um Agent lendo a saída, ou aparecem apesar do NO_COLOR; um caractere chinês, japonês ou coreano é contado como uma
// coluna, então as colunas depois dele desalinham e as linhas quebram além da borda; o que espera pelo titular afunda abaixo do
// que apenas relata; um aviso já tratado espalha o texto inteiro pela lista, ou o perde, embora aquele seja o único lugar onde o
// que o `tell` disse é lido. Uma regra pausada não diz quantos eventos deixou passar desde quando, quais, nem que há mais do que
// os que lista, ou imprime um deles mais largo que o terminal.
// O comando de reexecução que ela imprime, copiado como está, executa outra coisa: um nome de regra com $ ou uma crase expande,
// um que começa com # transforma o resto da linha em comentário.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { colorFor, render, replayCommand, width } from "../cli/status.ts";

const now = "2026-11-07T02:00:00.000Z"; // 10:00 em Asia/Shanghai
const run = (id: number, state: string, rule: string, more: object = {}) => ({
  id,
  rule,
  state,
  attempts: 0,
  claimedAt: now,
  finishedAt: state === "claimed" || state === "queued" ? null : now,
  notBefore: null,
  summary: "",
  error: "",
  stopping: false,
  events: [{ source: "schedule", type: "schedule.tick", subject: "", summary: "" }],
  ...more,
});
const state = {
  now,
  timezone: "Asia/Shanghai",
  spending: {
    today: { rounds: 0, tokens: 0, cached: 0, cost: 0, missingTokens: 0, missingCost: 0 },
    week: { rounds: 0, tokens: 0, cached: 0, cost: 0, missingTokens: 0, missingCost: 0 },
  },
  totals: { running: 1, queued: 0, retrying: 0, unknown: 0, doneToday: 1 },
  agents: [{ name: "Claude", worker: "m4", online: false, seenAt: "2026-11-06T13:00:00.000Z" }],
  channels: [{ name: "Feishu", online: true, seenAt: now }],
  sources: [{ id: "app", name: "aplicativo" }],
  lines: [
    { name: "briefing matinal", every: "todos os dias 9:00", next: "2026-11-08T01:00:00.000Z", paused: null },
    { name: "a", every: "a cada hora", next: "2026-11-07T03:00:00.000Z", paused: null },
  ],
  elsewhere: [],
  cards: [
    {
      id: 7,
      kind: "ask",
      title: "escolha uma",
      text: "veja a [explicação](https://example.com/x)",
      options: ["vermelho", "verde"],
      recommend: 1,
    },
  ],
  recentCards: [
    {
      id: 6,
      kind: "notice",
      state: "closed",
      title: "Para você saber",
      text: `Primeiro parágrafo${"\u{5f88}\u{957f}".repeat(80)}\n\nSegundo parágrafo veja o [link](https://example.com/notice)`,
      options: [],
      choice: null,
      answer: null,
    },
  ],
  runs: [run(3, "claimed", "briefing matinal"), run(2, "done", "briefing matinal", { summary: "pronto" })],
  unrouted: [{ source: "app", type: "x.new", subject: "#1", summary: "" }],
};

test("cor só num terminal sem NO_COLOR, e nenhuma quando ela está desligada", () => {
  assert.equal(colorFor({ isTTY: true }, {}), true);
  assert.equal(colorFor({ isTTY: false }, {}), false);
  assert.equal(colorFor({}, {}), false);
  assert.equal(colorFor({ isTTY: true }, { NO_COLOR: "1" }), false);
  assert.doesNotMatch(render(state, { color: false, columns: 100 }), /\x1b/);
  assert.match(render(state, { color: true, columns: 100 }), /\x1b\[/);
});

test("caracteres chineses, japoneses e coreanos ocupam duas colunas, e as colunas se alinham depois deles", () => {
  assert.equal(width("\u{4e2d}a"), 3);
  assert.equal(width("\u{65e5}\u{672c}\u{8a9e}"), 6);
  assert.equal(width("\u{d55c}"), 2);
  assert.equal(width("\x1b[1m\u{4e2d}\x1b[0m"), 2);
  const lines = render(state, { color: false, columns: 100 }).split("\n");
  const timed = lines.slice(lines.indexOf("Agendamentos") + 1, lines.indexOf("Agendamentos") + 3);
  const nextAt = timed.map((line) => width(line.slice(0, line.indexOf("próxima"))));
  assert.equal(nextAt[0], nextAt[1], timed.join("\n"));
  const text = render(
    { ...state, cards: [{ ...state.cards[0], text: "\u{957f}".repeat(200) }] },
    { color: false, columns: 60 },
  );
  // A linha de resumo das contagens não é quebrada pela fonte e, em pt-BR, é mais larga que 60 colunas; o que se verifica
  // aqui é que o conteúdo que a fonte quebra (cartões, rodadas, agendamentos) respeita a largura do terminal.
  for (const line of text.split("\n").slice(1)) assert.ok(width(line) <= 60, line);
});

test("o que espera pelo titular vem primeiro, depois o que está em curso, depois o que apenas relata", () => {
  const text = render(state, { color: false, columns: 100 });
  const order = [
    "Online",
    "Aguardando você 1",
    "Em andamento",
    "Rodadas recentes",
    "Cartões recentes",
    "Agendamentos",
    "Eventos sem regra",
  ];
  const at = order.map((heading) => text.split("\n").indexOf(heading));
  assert.ok(
    at.every((index) => index > 0),
    at.join(","),
  );
  assert.deepEqual(
    [...at].sort((a, b) => a - b),
    at,
  );
  assert.match(text.split("\n")[0], /^Aguardando você 1 · Em execução 1/);
  const notice = text.split("\n").filter((line) => line.includes("Primeiro parágrafo"));
  assert.equal(notice.length, 1, "um aviso já tratado ocupa uma linha, não o texto inteiro");
  assert.match(notice[0], /…$/);
  assert.doesNotMatch(text, /Segundo parágrafo/);
  assert.match(text, /https:\/\/example\.com\/x/);
  assert.doesNotMatch(text, /\]\(/, "um link aparece como as palavras dele e o endereço, não markdown");
});

test("uma regra pausada diz desde quando, quantos eventos ignorou, os mais recentes deles, e que há mais", () => {
  const event = (n: number) => ({
    id: 100 + n,
    source: "app",
    type: "feedback.new",
    subject: `#${n}`,
    summary: `evento ${n}`,
    receivedAt: `2026-11-07T01:0${n}:00.000Z`,
  });
  const pause = { by: "owner", until: null };
  const lines = [
    {
      name: "opiniões",
      every: null,
      next: null,
      paused: {
        ...pause,
        reason: "o downstream está em manutenção",
        since: "2026-11-06T10:00:00.000Z",
        skipped: { count: 7, events: [7, 6, 5, 4, 3, 2, 1].map(event) },
      },
    },
    {
      name: "briefing matinal",
      every: "todos os dias 9:00",
      next: "2026-11-08T01:00:00.000Z",
      paused: { ...pause, reason: "feriado", since: "2026-11-07T00:00:00.000Z", skipped: null },
    },
  ];
  const text = render({ ...state, lines }, { color: false, columns: 100 });
  const start = text.indexOf("Pausadas");
  const section = text.slice(start, text.indexOf("\n\n", start));
  assert.match(section, /opiniões: o downstream está em manutenção\n {4}Desde ontem 18:00, 7 eventos ignorados/);
  assert.deepEqual(
    [...section.matchAll(/09:0\d +aplicativo feedback\.new #(\d): evento \d/g)].map((match) => match[1]),
    ["7", "6", "5", "4", "3"],
  );
  assert.match(section, /Total de 7; os 5 mais recentes listados aqui/);
  assert.match(section, /briefing matinal: feriado\n {4}Desde 08:00$/);
  // A linha de um evento ignorado também se mantém na largura, cortada com "…": o resumo pode ser mais longo que o terminal.
  const wide = render(
    {
      ...state,
      lines: [
        {
          ...lines[0],
          paused: {
            ...lines[0].paused,
            skipped: {
              count: 1,
              events: [{ ...event(7), summary: "\u{5f88}\u{957f}\u{7684}\u{4e00}\u{53e5}\u{8bdd}".repeat(12) }],
            },
          },
        },
      ],
    },
    { color: false, columns: 100 },
  );
  const shown = wide.split("\n").find((one) => one.includes("feedback.new"))!;
  assert.ok(width(shown) <= 100, shown);
  assert.match(shown, /…$/);
});

const since = "2026-11-11T14:07:53.620Z";
const odd = ["opiniões $HOME `id`", "#99 opiniões", "@x", "it's", "a b", "\u2018lã\u2019 \u2019"];

test(
  "o comando de reexecução devolve o nome da regra e o horário sem alterações no sh, e um nome simples fica sem aspas",
  { skip: process.platform === "win32" },
  () => {
    assert.equal(replayCommand("opiniões", since, false), `agent-autoloop replay opiniões --since ${since}`);
    for (const rule of odd) {
      const command = replayCommand(rule, since, false);
      const args = execFileSync(
        "sh",
        ["-c", `set -- ${command.replace(/^agent-autoloop replay /, "")}; printf '%s\\n' "$@"`],
        { encoding: "utf8" },
      );
      assert.equal(args, `${rule}\n--since\n${since}\n`, command);
    }
  },
);

test("no Windows o comando de reexecução usa as aspas do jeito que o PowerShell as lê", () => {
  assert.equal(replayCommand("opiniões", since, true), `agent-autoloop replay opiniões --since ${since}`);
  assert.equal(replayCommand("it's $x", since, true), `agent-autoloop replay 'it''s $x' --since ${since}`);
  assert.equal(replayCommand("#99", since, true), `agent-autoloop replay '#99' --since ${since}`);
  assert.equal(replayCommand("@x", since, true), `agent-autoloop replay '@x' --since ${since}`);
  // O PowerShell aceita as aspas simples curvas como suas: cada uma é duplicada como a reta, senão um nome com elas encerra a citação.
  assert.equal(replayCommand("O’Reilly", since, true), `agent-autoloop replay 'O’’Reilly' --since ${since}`);
  assert.equal(
    replayCommand("\u2018lã\u2019; rm x", since, true),
    `agent-autoloop replay '\u2018\u2018lã\u2019\u2019; rm x' --since ${since}`,
  );
  assert.equal(replayCommand("‚a‛", since, true), `agent-autoloop replay '‚‚a‛‛' --since ${since}`);
});
