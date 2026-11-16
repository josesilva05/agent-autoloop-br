// Cron de cinco campos no fuso horário das regras: quando vem a próxima. Como no cron, um dia do mês e um dia da semana
// dados ao mesmo tempo aceitam qualquer um dos dois, mas quando um deles começa com * o dia precisa casar com ambos;
// 0 e 7 são domingo. Um instante de relógio que não existe (relógios adiantando) é pulado, e um que acontece duas vezes
// (relógios atrasando) conta na primeira, então um agendamento dispara no máximo uma vez por instante de relógio.
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Longo o bastante para caber um dia bissexto; um agendamento sem nenhuma ocorrência nunca chega. */
const HORIZON = 8 * 366;
/** O que cada um dos cinco campos pode conter. */
const LOWEST = [0, 0, 1, 1, 0];
const HIGHEST = [59, 23, 31, 12, 7];

function field(text: string, min: number, max: number) {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!match) return null;
    const [, all, from, to, step] = match;
    const start = all === "*" ? min : Number(from);
    const end = all === "*" ? max : to !== undefined ? Number(to) : step !== undefined ? max : start;
    const by = step === undefined ? 1 : Number(step);
    if (start < min || end > max || start > end || by < 1) return null;
    for (let value = start; value <= end; value += by) values.add(value);
  }
  return values;
}

export function parseCron(text: string) {
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const sets = parts.map((part, index) => field(part, LOWEST[index], HIGHEST[index]));
  if (sets.some((set) => set === null)) return null;
  const [minutes, hours, days, months, weekdays] = sets as Set<number>[];
  if (weekdays.delete(7)) weekdays.add(0);
  const sorted = (set: Set<number>) => [...set].sort((a, b) => a - b);
  const anyDay = parts[2].startsWith("*");
  const anyWeekday = parts[4].startsWith("*");
  return { minutes: sorted(minutes), hours: sorted(hours), days, months, weekdays, anyDay, anyWeekday };
}

export type Cron = NonNullable<ReturnType<typeof parseCron>>;
const formats = new Map<string, Intl.DateTimeFormat>();

function wallClock(ms: number, zone: string) {
  let format = formats.get(zone);
  if (!format) {
    const fields = { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" } as const;
    format = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", ...fields });
    formats.set(zone, format);
  }
  return Object.fromEntries(format.formatToParts(ms).map((part) => [part.type, Number(part.value)]));
}

/** O quanto o relógio do fuso está adiantado em relação ao UTC neste instante. */
function offset(ms: number, zone: string) {
  const clock = wallClock(ms, zone);
  return Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute) - Math.floor(ms / MINUTE) * MINUTE;
}

/** O primeiro instante em que o relógio deste fuso marca isso, ou null se ele nunca chegar a marcar. */
function moment(year: number, month: number, day: number, hour: number, minute: number, zone: string) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const tries = [...new Set([guess - offset(guess - DAY, zone), guess - offset(guess + DAY, zone)])];
  const matches = (at: number) => {
    const clock = wallClock(at, zone);
    return clock.day === day && clock.hour === hour && clock.minute === minute;
  };
  return tries.sort((a, b) => a - b).find(matches) ?? null;
}

/** O primeiro minuto estritamente depois de `after` que o agendamento nomeia, ou null se ele nunca chegar. */
export function nextRun(cron: Cron, after: number, zone: string): number | null {
  const start = wallClock(after, zone);
  const first = Date.UTC(start.year, start.month - 1, start.day);
  for (let dayIndex = 0; dayIndex < HORIZON; dayIndex++) {
    const date = new Date(first + dayIndex * DAY);
    if (!cron.months.has(date.getUTCMonth() + 1)) continue;
    const onDay = cron.days.has(date.getUTCDate());
    const onWeekday = cron.weekdays.has(date.getUTCDay());
    if (!(cron.anyDay || cron.anyWeekday ? onDay && onWeekday : onDay || onWeekday)) continue;
    for (const hour of cron.hours) {
      if (dayIndex === 0 && hour < start.hour) continue;
      for (const minute of cron.minutes) {
        // O que é mais cedo no primeiro dia já aconteceu: um instante conta na primeira vez em que o relógio o marca.
        if (dayIndex === 0 && hour === start.hour && minute < start.minute) continue;
        const at = moment(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), hour, minute, zone);
        if (at !== null && at > after) return at;
      }
    }
  }
  return null;
}

/** A última vencida em ou antes de `now`, dado que `due` venceu: o que uma central adormecida ainda deve, uma vez só. */
export function latestBefore(cron: Cron, due: number, now: number, zone: string) {
  // Olha para trás em janelas cada vez mais largas: um agendamento por minuto após um ano dormindo não percorre o ano.
  for (const window of [HOUR, DAY, 32 * DAY, 400 * DAY, Infinity]) {
    let latest: number | null = null;
    let at: number | null = window === Infinity || now - window < due ? due : nextRun(cron, now - window, zone);
    while (at !== null && at <= now) {
      latest = at;
      at = nextRun(cron, at, zone);
    }
    if (latest !== null) return latest;
  }
  return due;
}

export function dayStart(now: number, zone: string) {
  const clock = wallClock(now, zone);
  return moment(clock.year, clock.month, clock.day, 0, 0, zone) ?? now;
}

// Junto com o resto do cron e não com o resumo do status: a página de um cliente pode importar este arquivo, que não
// precisa de nada do Node.
const WEEKDAYS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb", "dom"];

/** Um agendamento comum em palavras (todos os dias 18:00, todo dom 06:00, dias úteis 09:00, dia 1 de cada mês 04:00);
 * qualquer outro, como foi escrito. */
export function describeCron(text: string) {
  const [minute, hour, day, month, weekday] = text.trim().split(/\s+/);
  const number = /^\d+$/;
  if (!number.test(minute) || !number.test(hour) || month !== "*" || !parseCron(text)) return text;
  const at = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
  if (day === "*" && weekday === "*") return `todos os dias ${at}`;
  if (day === "*" && number.test(weekday)) return `todo ${WEEKDAYS[Number(weekday)]} ${at}`;
  if (day === "*" && weekday === "1-5") return `dias úteis ${at}`;
  if (number.test(day) && weekday === "*") return `dia ${Number(day)} de cada mês ${at}`;
  return text;
}
