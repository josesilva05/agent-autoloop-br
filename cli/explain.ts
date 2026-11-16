// `rules explain` e `emit --dry-run`: o que o ficheiro de regras desta máquina diz, sem perguntar a uma central nem gravar um fato.
import { describeCron, nextRun, parseCron } from "../kernel/cron.ts";
import { cronOf, eventRule, typeMatches, type Rule, type Rules } from "../kernel/rules.ts";
import { parseRules } from "../protocol/rules.ts";
import { parseEvent } from "../protocol/validate.ts";

const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const clock = (zone: string) =>
  ({ timeZone: zone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) as const;
const when = (rule: Rule, rules: Rules, now: number) =>
  eventRule(rule)
    ? `fonte ${rule.when.source} · ${rule.when.types.join(", ")}`
    : `agendamento ${describeCron(cronOf(rule))} (próxima ${new Date(
        nextRun(parseCron(cronOf(rule))!, now, rules.timezone)!,
      ).toLocaleString("pt-BR", clock(rules.timezone))})`;

function details(rule: Rule, rules: Rules, now: number) {
  const parts = [when(rule, rules, now), `→ ${rule.to}`, rule.cwd];
  if (rule.parallel) parts.push(`paralelismo ${rule.parallel}`);
  if (rule.maxActive) parts.push(`no máximo ${rule.maxActive} rodadas simultâneas nesta regra`);
  if (rule.channels?.length) parts.push(`envia apenas para ${rule.channels.join(", ")}`);
  if (rule.resume) parts.push("continuando a sessão da rodada anterior");
  if (rule.title) parts.push(`título de sessão ${rule.title}`);
  if (rule.group !== rule.name) parts.push(`grupo ${rule.group}`);
  if (rule.tell !== "needed") parts.push(`notificação ${rule.tell}`);
  if (rule.skill) parts.push("tem Skill");
  if (rule.prompt) parts.push("tem Prompt");
  if (rule.emits) parts.push(`pode emitir ${rule.emits.source} ${rule.emits.types.join(", ")}`);
  return parts.join(" · ");
}

/** As regras como esta máquina as executaria, uma linha por coisa que o titular pergunta. */
export function explainRules(text: string, now = Date.now(), zone = localZone()): string[] {
  const rules = parseRules(text, now, zone);
  const lines = [
    `Fuso ${rules.timezone}; pergunta antes: ${rules.askFirst.join(", ")}; ${rules.rules.length} regras`,
    `Fontes: ${Object.entries(rules.sources)
      .map(([id, source]) => `${id} (${source.name})`)
      .join(", ")}`,
    `Agents: ${Object.entries(rules.agents)
      .map(([id, agent]) => {
        const limit = agent.maxActive ? `, no máximo ${agent.maxActive} rodadas simultâneas` : "";
        return `${id} (${agent.name}, ${agent.worker}, permissão ${agent.access}${limit})`;
      })
      .join(", ")}`,
  ];
  if (Object.keys(rules.channels).length)
    lines.push(
      `Canais: ${Object.entries(rules.channels)
        .map(([id, channel]) => {
          const answerers = channel.answerers?.length ? `, quem responde ${channel.answerers.join(", ")}` : "";
          return `${id} (${channel.name}${answerers}${channel.links ? ", com links" : ""})`;
        })
        .join(", ")}`,
    );
  if (rules.defaultChannels)
    lines.push(`Cartões e notificações sem channels vão por padrão apenas para ${rules.defaultChannels.join(", ")}`);
  lines.push("Regras:");
  for (const rule of rules.rules) lines.push(`  ${rule.name}: ${details(rule, rules, now)}`);
  for (const task of rules.elsewhere) {
    const answers = task.cwd
      ? `; pergunta a você e, após a resposta, ${rules.agents[task.to].name} continua em ${task.cwd}`
      : "";
    lines.push(`  ${task.name}: em outro lugar (${task.where}) ${describeCron(task.cron)}${answers}`);
  }
  return lines;
}

/** A quem um evento de fonte seria entregue, só pelo ficheiro de regras: sem central, sem registro, sem chave. */
export function previewEvent(
  text: string,
  source: string,
  event: unknown,
  now = Date.now(),
  zone = localZone(),
): string[] {
  const rules = parseRules(text, now, zone);
  const parsed = parseEvent(event);
  const lines = [`Evento: ${source} ${parsed.type}${parsed.subject ? ` ${parsed.subject}` : ""}`];
  if (!rules.sources[source]) lines.push(`A fonte ${source} não está registrada em sources no rules.json`);
  const matched = rules.rules.filter(
    (rule) => eventRule(rule) && rule.when.source === source && typeMatches(rule.when.types, parsed.type),
  );
  if (!matched.length) {
    lines.push('Nenhuma regra recebe este evento; se enviado de verdade, seria registrado como "Eventos sem regra".');
    return lines;
  }
  lines.push("Será despachado para:");
  for (const rule of matched) lines.push(`  ${rule.name} → ${rule.to} · ${rule.cwd}`);
  return lines;
}
