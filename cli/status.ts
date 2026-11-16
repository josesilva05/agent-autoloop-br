// O `agent-autoloop status` para uma pessoa: primeiro o que espera por ela, depois o que está acontecendo, e por fim o que
// apenas relata. Cor só num terminal: um pipe, um ficheiro ou um Agent lendo a saída recebem texto puro, e scripts usam --json.
import { spendLines } from "./spend.ts";

type Style = (text: string) => string;

/** https://no-color.org: definida e não vazia desliga a cor. */
export const colorFor = (out: { isTTY?: boolean }, env: Record<string, string | undefined>) =>
  out.isTTY === true && !env.NO_COLOR;

// Hangul Jamo, radicais CJK até Yi, sílabas Hangul, ideogramas e formas de compatibilidade, formas de largura total e os
// planos suplementares de ideogramas: os caracteres que um terminal desenha com duas colunas de largura.
const WIDE =
  /[\u{1100}-\u{115f}\u{2e80}-\u{a4cf}\u{ac00}-\u{d7a3}\u{f900}-\u{faff}\u{fe30}-\u{fe4f}\u{ff00}-\u{ff60}\u{ffe0}-\u{ffe6}\u{20000}-\u{3fffd}]/u;
const ANSI = /\x1b\[[0-9;]*m/g;
export const width = (text: string) =>
  [...text.replace(ANSI, "")].reduce((sum, char) => sum + (WIDE.test(char) ? 2 : 1), 0);
const pad = (text: string, to: number) => text + " ".repeat(Math.max(0, to - width(text)));

const CLOSING = "”»],.;:!?)";
/** Texto puro em linhas de no máximo `room` de largura, no máximo `max` delas, a última cortada com "…". */
function wrap(text: string, room: number, max = Infinity): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const char of paragraph) {
      // A pontuação de fechamento fica com o que ela fecha em vez de começar uma linha.
      if (line && width(line + char) > room && !CLOSING.includes(char)) {
        // Uma palavra latina passa inteira para a linha seguinte; o espaço onde ela quebra não é mantido.
        const space = line.lastIndexOf(" ");
        const word = line.slice(space + 1);
        const whole = char !== " " && space > 0 && /^[\x21-\x7e]+$/.test(word) && /[\x21-\x7e]/.test(char);
        lines.push((whole ? line.slice(0, space) : line).trimEnd());
        line = whole ? word : "";
        if (char === " ") continue;
      }
      line += char;
    }
    lines.push(line);
  }
  if (lines.length <= max) return lines;
  const kept = lines.slice(0, max);
  let last = kept[max - 1];
  while (last && width(last + "…") > room) last = [...last].slice(0, -1).join("");
  kept[max - 1] = `${last}…`;
  return kept;
}

const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;
const unlinked = (text: string) => text.replace(LINK, "$1");

const WEEK = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

/** Cores que só existem num terminal. */
function stylesFor(color: boolean) {
  const sgr =
    (code: string): Style =>
    (text) =>
      color ? `\x1b[${code}m${text}\x1b[0m` : text;
  const [bold, dim, underline, red, green, yellow, magenta, cyan] = ["1", "2", "4", "31", "32", "33", "35", "36"].map(
    sgr,
  );
  return { bold, dim, underline, red, green, yellow, magenta, cyan, heading: sgr("1;34") };
}

/** Horários como uma pessoa os lê, no fuso da central e contados a partir do agora da central. */
export function clockFor(state: { now: string; timezone: string }) {
  const zone = state.timezone;
  const now = Date.parse(state.now);
  const dayOf = (at: number) => {
    const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(at).split("-").map(Number);
    return Date.UTC(y, m - 1, d) / 86_400_000;
  };
  const clock = (at: number) =>
    new Date(at).toLocaleString("pt-BR", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  /** O de hoje é só a hora; ontem, amanhã e a semana que vem pelo nome; mais adiante pela data. */
  const when = (iso: string) => {
    const at = Date.parse(iso);
    const days = dayOf(at) - dayOf(now);
    if (days === 0) return clock(at);
    if (days === -1) return `ontem ${clock(at)}`;
    if (days === 1) return `amanhã ${clock(at)}`;
    if (days > 1 && days < 7) return `${WEEK[new Date(dayOf(at) * 86_400_000).getUTCDay()]} ${clock(at)}`;
    const date = new Date(at).toLocaleString("pt-BR", { timeZone: zone, month: "numeric", day: "numeric" });
    return `${date} ${clock(at)}`;
  };
  const lasted = (iso: string) => {
    const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
    return minutes < 60
      ? `${minutes} ${minutes === 1 ? "minuto" : "minutos"}`
      : `${Math.floor(minutes / 60)} ${Math.floor(minutes / 60) === 1 ? "hora" : "horas"} ${minutes % 60} ${
          minutes % 60 === 1 ? "minuto" : "minutos"
        }`;
  };
  return { when, lasted };
}

// Uma palavra que tanto o sh quanto o PowerShell aceitam como está: # começa um comentário e @ um splat só no início da palavra.
const PLAIN = /^[\p{L}\p{N}_./][\p{L}\p{N}_.#@:/-]*$/u;

/** Uma palavra que o shell do usuário devolve sem alterações: aspas simples, que nenhum dos dois expande por dentro, e cada
 * shell as escapa à sua maneira. O PowerShell também aceita as aspas simples curvas (comuns em texto chinês) como aspas, então
 * cada uma delas também é duplicada. */
const shellWord = (word: string, windows: boolean) =>
  PLAIN.test(word)
    ? word
    : windows
      ? `'${word.replace(/['\u2018\u2019\u201a\u201b]/g, "$&$&")}'`
      : `'${word.replaceAll("'", `'\\''`)}'`;

/** O comando que entrega a uma regra o que a pausa dela deixou passar desde então, para copiar como está no shell desta máquina. */
export const replayCommand = (rule: string, since: string, windows = process.platform === "win32") =>
  `agent-autoloop replay ${shellWord(rule, windows)} --since ${shellWord(since, windows)}`;

/** Um evento que a pausa deixou passar, numa linha de no máximo `room`: quando chegou, de onde, o quê e sobre o quê. */
export function skippedLine(event: any, room: number, when: (iso: string) => string, from = (id: string) => id) {
  const head = `${when(event.receivedAt)}  `;
  const what = `${from(event.source)} ${event.type} ${event.subject}${event.summary ? `: ${event.summary}` : ""}`;
  return head + wrap(what, room - width(head), 1)[0];
}

/** Uma rodada concluída não está mais em curso nem à espera de começar. */
export const finished = (run: any) => run.state !== "claimed" && run.state !== "queued";

/** Rodadas concluídas, cada uma a sua entrada: quando terminou, o seu número, como e a sua regra, e depois uma ou duas linhas do que resultou. */
export function runRows(state: any, runs: any[], { color, columns }: { color: boolean; columns?: number }) {
  const room = Math.min(columns || 100, 120);
  const { dim, red, green, yellow } = stylesFor(color);
  const { when } = clockFor(state);
  const RUN_LOOK: Record<string, [string, Style]> = {
    done: ["Concluído", green],
    nothing: ["Nada a fazer", dim],
    cancelled: ["Interrompida", yellow],
    unknown: ["Incerto", red],
  };
  const out: string[] = [];
  const ended = runs.map((run: any) => (run.finishedAt ? when(run.finishedAt) : ""));
  const timeRoom = Math.max(0, ...ended.map(width));
  const runRoom = Math.max(0, ...runs.map((run: any) => width(`#${run.id}`)));
  const lookRoom = Math.max(...Object.values(RUN_LOOK).map(([label]) => width(label)));
  runs.forEach((run: any, index: number) => {
    const [label, style] = RUN_LOOK[run.state] ?? [run.state, (text: string) => text];
    const before = `  ${pad(ended[index], timeRoom)} ${pad(`#${run.id}`, runRoom)} ${pad(label, lookRoom)} `;
    out.push(
      `  ${dim(pad(ended[index], timeRoom))} ${dim(pad(`#${run.id}`, runRoom))} ${style(pad(label, lookRoom))} ${run.rule}`,
    );
    const outcome = run.error || run.summary;
    if (!outcome) return;
    const look = run.error ? red : run.state === "nothing" ? dim : (text: string) => text;
    const indent = " ".repeat(width(before));
    for (const line of wrap(unlinked(outcome), room - indent.length, 2)) out.push(indent + look(line));
  });
  return out;
}

export function render(state: any, { color, columns }: { color: boolean; columns?: number }) {
  const room = Math.min(columns || 100, 120);
  const { bold, dim, underline, red, green, yellow, magenta, cyan, heading } = stylesFor(color);
  const { when, lasted } = clockFor(state);

  const out: string[] = [];
  const say = (line = "") => out.push(line);
  const section = (title: string) => {
    say();
    say(title);
  };

  const { totals } = state;
  const count = (label: string, n: number, style: Style) =>
    n > 0 ? `${label} ${bold(style(String(n)))}` : dim(`${label} 0`);
  say(
    [
      count("Aguardando você", state.cards.length, yellow),
      count("Em execução", totals.running, cyan),
      count("Na fila", totals.queued - totals.retrying, yellow),
      totals.retrying ? count("Aguardando novo despacho", totals.retrying, yellow) : "",
      totals.unknown ? count("Incerto", totals.unknown, red) : "",
      `Concluídas hoje ${totals.doneToday}`,
    ]
      .filter(Boolean)
      .join(dim(" · ")),
  );
  for (const line of spendLines(state.spending)) say(dim(line));

  const presence = [
    ...state.agents.map((agent: any) => ({ ...agent, where: agent.worker })),
    ...state.channels.map((channel: any) => ({ ...channel, where: "canal" })),
  ];
  if (presence.length) section(heading("Online"));
  const nameRoom = Math.max(0, ...presence.map((one) => width(one.name)));
  const whereRoom = Math.max(0, ...presence.map((one) => width(one.where)));
  for (const one of presence) {
    const head = `  ${one.online ? green("●") : red("○")} ${pad(one.name, nameRoom)}  `;
    if (one.online) say(head + dim(one.where));
    else
      say(
        `${head}${dim(pad(one.where, whereRoom))}  ${red(
          `Offline; última conexão ${one.seenAt ? when(one.seenAt) : "nunca"}`,
        )}`,
      );
  }

  const sourceName = (id: string) => state.sources.find((one: any) => one.id === id)?.name ?? id;
  const paused = state.lines.filter((line: any) => line.paused);
  if (paused.length) section(`${heading("Pausadas")}${dim("(retomar: agent-autoloop resume <regra>)")}`);
  for (const line of paused) {
    const { reason, since, until, skipped } = line.paused;
    say(`  ${line.name}${reason ? dim(`: ${reason}`) : ""}`);
    // Um agendamento deixa os seus momentos passarem e não guarda eventos, por isso não tem contagem.
    const ends = until ? `; retoma automaticamente ${when(until)}` : "";
    say(dim(`    Desde ${when(since)}${ends}${skipped ? `, ${skipped.count} eventos ignorados` : ""}`));
    const shown = skipped?.events.slice(0, 5) ?? [];
    for (const event of shown) say(`      ${skippedLine(event, room - 6, when, sourceName)}`);
    if (shown.length < (skipped?.count ?? 0))
      say(dim(`      Total de ${skipped.count}; os ${shown.length} mais recentes listados aqui`));
    // Ninguém lê nada quando uma pausa termina sozinha, então o caminho para reexecutar é dito enquanto ela dura.
    if (until && skipped?.count)
      say(dim(`    Esses eventos não serão listados na hora; reexecute depois: ${replayCommand(line.name, since)}`));
  }

  const INDENT = "       ";
  if (state.cards.length) section(bold(yellow(`Aguardando você ${state.cards.length}`)));
  for (const card of state.cards) {
    const label = card.kind === "ask" ? bold(yellow("Decisão")) : bold(magenta("Atenção"));
    say(`  ${label} ${dim(`#${card.id}`)} ${bold(card.title)}`);
    if (card.rule && card.rule !== card.title) say(dim(`${INDENT}Fonte: ${card.rule}`));
    for (const paragraph of (card.text ?? "").split(/\n\s*\n/).filter((one: string) => one.trim())) {
      for (const line of wrap(unlinked(paragraph), room - INDENT.length)) say(INDENT + line);
      for (const [, words, url] of paragraph.matchAll(LINK)) say(`${INDENT}${underline(words)} ${dim(url)}`);
    }
    if (card.kind === "ask") {
      card.options.forEach((option: string, index: number) => {
        say(`${INDENT}${index + 1}. ${option}${index === card.recommend ? green(" (recomendado)") : ""}`);
      });
      say(dim(`${INDENT}Responder: agent-autoloop answer ${card.id} <número>`));
    } else say(dim(`${INDENT}Resolvido: agent-autoloop answer ${card.id}`));
  }

  const because = (event: { source: string; type: string; subject: string; summary: string }) => {
    if (event.type === "card.answered") return `Você respondeu ao cartão "${event.summary}"`;
    if (event.type === "schedule.tick") return "horário atingido";
    if (event.type === "timer.due")
      return `A reverificação combinada venceu${event.subject ? `: ${event.subject}` : ""}`;
    if (event.type === "run.manual") return event.summary;
    return `${sourceName(event.source)} ${event.type} ${event.summary || event.subject}`.trim();
  };
  const running = state.runs.filter((run: any) => run.state === "claimed");
  const queued = state.runs.filter((run: any) => run.state === "queued");
  if (running.length || queued.length) section(heading("Em andamento"));
  for (const run of running) {
    const stopping = run.stopping ? `  ${yellow("parando")}` : "";
    say(`  ${dim(`#${run.id}`)} ${run.rule}  ${cyan(`Em execução há ${lasted(run.claimedAt)}`)}${stopping}`);
    if (run.events[0])
      for (const line of wrap(`Porque ${because(run.events[0])}`, room - 6, 1)) say(`      ${dim(line)}`);
  }
  for (const run of queued) {
    const retry = run.attempts > 0;
    say(
      `  ${dim(`#${run.id}`)} ${run.rule}  ${yellow(
        retry ? `Aguardando novo despacho; nova tentativa ${when(run.notBefore)}` : "Na fila",
      )}`,
    );
    if (retry && run.error) for (const line of wrap(run.error, room - 6, 2)) say(`      ${red(line)}`);
  }

  const recentRuns = state.runs.filter(finished).slice(0, 8);
  if (recentRuns.length) section(heading("Rodadas recentes"));
  for (const line of runRows(state, recentRuns, { color, columns })) say(line);

  const CARD_LOOK: Record<string, [string, Style]> = {
    decided: ["Respondido", cyan],
    done: ["Concluído", green],
    closed: ["Fechado", dim],
  };
  const recent = state.recentCards.slice(0, 5);
  if (recent.length) section(heading("Cartões recentes"));
  const cardRoom = Math.max(0, ...recent.map((card: any) => width(`#${card.id}`)));
  for (const card of recent) {
    const [label, style] =
      card.kind === "notice" && card.state === "closed"
        ? ["Resolvido", dim]
        : (CARD_LOOK[card.state] ?? [card.state, (text: string) => text]);
    const before = `  ${pad(`#${card.id}`, cardRoom)} ${pad(label, 6)} `;
    const [title] = wrap(card.title, room - width(before), 1);
    say(`  ${dim(pad(`#${card.id}`, cardRoom))} ${style(pad(label, 6))} ${bold(title)}`);
    const indent = " ".repeat(width(before));
    const parts: [string, Style][] = [];
    if (card.choice !== null && card.choice !== undefined)
      parts.push([`Você escolheu ${card.options[card.choice]}`, green]);
    if (card.answer) parts.push([`Você disse: ${card.answer}`, (text) => text]);
    // Um aviso já tratado diz isso no próprio rótulo.
    if (card.result && card.result !== "Resolvido") parts.push([unlinked(card.result), (text) => text]);
    else if (card.state === "decided") parts.push(["O Agent continua trabalhando", dim]);
    // O que o `tell` diz é encerrado assim que é criado, então é aqui que se lê; uma linha mantém a lista uma lista.
    else if (card.kind === "notice" && card.text) parts.push([unlinked(card.text), dim]);
    if (!parts.length) continue;
    const plain = parts.map(([text]) => text.replace(/\s*\n\s*/g, " ")).join(" → ");
    const lines = wrap(plain, room - indent.length, card.kind === "notice" ? 1 : 2);
    if (lines.length === 1 && lines[0] === plain)
      say(indent + parts.map(([text, look]) => look(text)).join(dim(" → ")));
    else for (const line of lines) say(indent + line);
  }

  const timed = [...state.lines.filter((line: any) => line.every), ...state.elsewhere];
  if (timed.length) section(heading("Agendamentos"));
  const ruleRoom = Math.max(0, ...timed.map((line: any) => width(line.name)));
  const everyRoom = Math.max(0, ...timed.map((line: any) => width(line.every)));
  for (const line of timed) {
    const head = `  ${pad(line.name, ruleRoom)}  ${pad(line.every, everyRoom)}  próxima ${when(line.next)}`;
    const [where] = line.where ? wrap(`(em outro lugar: ${line.where})`, room - width(head), 1) : [""];
    say(
      `  ${pad(line.name, ruleRoom)}  ${pad(line.every, everyRoom)}  ${dim("próxima")} ${when(line.next)}${dim(where)}`,
    );
  }

  const unrouted = state.unrouted.slice(0, 5);
  if (unrouted.length) section(heading("Eventos sem regra"));
  for (const event of unrouted) {
    const words = `${sourceName(event.source)} ${event.type} ${event.subject}`;
    say(`  ${yellow(words)}${event.summary ? dim(`: ${event.summary}`) : ""}`);
  }
  return out.join("\n");
}
