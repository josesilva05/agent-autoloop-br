// O que o kernel lê nas regras: o formato delas e quais eventos uma regra pega. O arquivo de regras é conferido antes de
// chegar aqui, em protocol/rules.ts.
export type Access = "read" | "edit" | "full";
export type Source = { name: string; adapter?: string };
type AgentOptions = {
  model?: string;
  effort?: string;
  tier?: string;
  command?: string[];
  program?: string;
  timeout?: number;
};
export type Agent = AgentOptions & { name: string; worker: string; use: string; access: Access; maxActive?: number };
export type Channel = { name: string; answerers?: string[]; links?: boolean };
export type Tell = "always" | "needed" | "never";
type EventFilter = { source: string; types: string[] };
type When = EventFilter | { cron: string };
type RuleWords = { skill?: string; prompt?: string };
/** O nome de uma sessão para clientes que o pegam da primeira linha: {subject} e {id} preenchidos pelo worker. */
type RuleOptions = RuleWords & {
  title?: string;
  parallel?: number;
  maxActive?: number;
  resume?: boolean;
  emits?: EventFilter;
};
/** Sem channels, os cartões de uma regra chegam aos padrões, ou a todo canal se não houver nenhum; com eles, só àqueles. */
type Reach = { channels?: string[] };
/** Sem parallel, o grupo de uma regra roda um de cada vez; com ele, cada objeto é seu próprio assunto, tantos por vez. */
export type Rule = RuleOptions &
  Reach & { name: string; when: When; to: string; cwd: string; group: string; tell: Tell };
/** Uma tarefa agendada que roda em outro lugar (digamos, no app do Claude): a central não a inicia nem a registra. Com um
 * cwd ela também pode perguntar, e a sua resposta segue para lá como uma rodada de uma regra. */
export type Elsewhere = RuleWords & {
  name: string;
  source: string;
  to: string;
  cron: string;
  where: string;
  /** Com o que o aplicativo dele a roda, só para exibição: a central não inicia nada com eles. */
  model?: string;
  effort?: string;
  cwd?: string;
};
type Registered = { sources: Record<string, Source>; agents: Record<string, Agent>; channels: Record<string, Channel> };
export type Rules = Registered & {
  timezone: string;
  askFirst: string[];
  /** Para onde vai um cartão que não nomeia canais próprios: um tell, os alertas da própria central, uma regra sem lista. */
  defaultChannels?: string[];
  rules: Rule[];
  elsewhere: Elsewhere[];
};

/** A fonte daquilo que o relógio faz acontecer. */
export const SCHEDULE = "schedule";

function typeMatch(pattern: string, type: string) {
  return pattern === "*" || pattern === type || (pattern.endsWith(".*") && type.startsWith(pattern.slice(0, -1)));
}
export const typeMatches = (patterns: string[], type: string) => patterns.some((pattern) => typeMatch(pattern, type));
export const eventRule = (rule: Rule): rule is Rule & { when: EventFilter } => "source" in rule.when;
export const cronOf = (rule: Rule) => (rule.when as { cron: string }).cron;

/** A regra que uma rodada, cartão ou reverificação nomeia: uma regra, ou uma tarefa de outro lugar, que só as suas respostas iniciam. */
export function ruleOf(rules: Rules, name: string): Rule | undefined {
  const rule = rules.rules.find((rule) => rule.name === name);
  if (rule) return rule;
  const task = rules.elsewhere.find((task) => task.name === name);
  if (!task?.cwd) return undefined;
  const { source, to, cwd, skill, prompt } = task;
  // Nenhum tipo de evento casa com uma lista vazia: nada que chega a inicia.
  return { name, when: { source, types: [] }, to, cwd, skill, prompt, group: name, tell: "needed" };
}
