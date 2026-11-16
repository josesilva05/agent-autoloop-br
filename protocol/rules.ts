// rules.json: as fontes que podem enviar eventos, os Agents que fazem o trabalho, os canais que chegam ao titular, as
// regras entre eles e, só para exibir, as tarefas agendadas que rodam em outro lugar. Um erro é pego aqui com uma
// mensagem dizendo onde: na partida ele impede a central de subir; depois, mantém as regras antigas e avisa o titular.
import { nextRun, parseCron } from "../kernel/cron.ts";
import { SCHEDULE, type Rule, type Rules } from "../kernel/rules.ts";

export class RulesError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`O rules.json tem problemas:\n${issues.join("\n")}`);
    this.issues = issues;
  }
}

const ACCESS = ["read", "edit", "full"];
const TELLS = ["always", "needed", "never"];
const ID = /^[a-z][a-z0-9-]*$/;
const TYPE_PATTERN = /^(\*|[a-z][a-z0-9_.-]{0,63}(\.\*)?)$/;
const ASK_FIRST = [
  "apagar dados",
  "derrubar serviço",
  "gastar dinheiro",
  "enviar mensagens a terceiros",
  "mudar a direção do produto",
  "criar ou rotacionar chaves",
  "alterar permissões",
];
const NOT_EMPTY = "não pode ficar vazio";
const ID_WORDS = "só pode usar letras minúsculas, números e -";

type Check = (value: unknown) => boolean;
type Field = [name: string, check: Check, problem: string, optional?: boolean];

const isText: Check = (value) => typeof value === "string" && value.trim() !== "";
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isWords: Check = (value) => Array.isArray(value) && value.every(isText);
const isSomeWords: Check = (value) => isWords(value) && (value as string[]).length > 0;
const isId: Check = (value) => typeof value === "string" && ID.test(value);
const isCount: Check = (value) => Number.isInteger(value) && (value as number) > 0;
const isTypes: Check = (value) => isSomeWords(value) && (value as string[]).every((type) => TYPE_PATTERN.test(type));
const isCron: Check = (value) => typeof value === "string" && parseCron(value) !== null;
// Uma palavra só, já que um cliente pode nomear uma sessão pela primeira palavra da primeira mensagem dela. Ela abre o
// prompt, que vai para a linha de comando do Agent como argumento: começando com um objeto vindo de fora, poderia ser
// lido como uma opção ou um comando.
const isTitle: Check = (value) =>
  typeof value === "string" &&
  /^[\p{L}\p{N}]\S*$/u.test(value) &&
  !/[{}]/.test(value.replaceAll("{id}", "").replaceAll("{subject}", ""));
const isFolder: Check = (value) =>
  typeof value === "string" && /^(~[/\\]|\/|[a-z]:[/\\]|\\\\[^\\]+\\[^\\]+)/i.test(value);
const FOLDER =
  "deve ser um diretório absoluto (por exemplo ~/code, /srv/app, C:\\code ou \\\\servidor\\compartilhamento)";

function isKeyOf(table: object): Check {
  return (value) => typeof value === "string" && value in table;
}

function isZone(zone: unknown) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone as string });
    return isText(zone);
  } catch {
    return false;
  }
}

/** Cada campo presente e bem formado, e nenhum outro: um campo com o nome errado seria ignorado em silêncio. */
function checkFields(issues: string[], where: string, value: unknown, spec: Field[]) {
  if (!isObject(value)) return void issues.push(`${where}deve ser um objeto`);
  for (const [name, check, problem, optional] of spec) {
    if (!(name in value)) {
      if (!optional) issues.push(`${where}está sem ${name}`);
    } else if (!check(value[name])) issues.push(`${where}o campo ${name} ${problem}`);
  }
  for (const name of Object.keys(value)) {
    if (!spec.some(([known]) => known === name)) issues.push(`${where}tem o campo desconhecido ${name}`);
  }
}

const nameOf = (entry: unknown) => (isObject(entry) && typeof entry.name === "string" ? entry.name : "");

function checkRule(issues: string[], rules: Rules, rule: Rule, names: Set<string>, now: number) {
  const name = nameOf(rule);
  if (names.has(name)) issues.push(`o nome de regra "${name}" está duplicado`);
  names.add(name);
  const where = `a regra "${name}": `;
  const when = isObject(rule) ? rule.when : undefined;
  checkFields(issues, where, rule, [
    ["name", isText, NOT_EMPTY],
    ["when", isObject, "deve ser um objeto"],
    ["to", isKeyOf(rules.agents), `não é um Agent registrado: ${isObject(rule) ? rule.to : ""}`],
    ["cwd", isFolder, FOLDER],
    ["skill", isText, NOT_EMPTY, true],
    ["prompt", isText, NOT_EMPTY, true],
    [
      "title",
      isTitle,
      "deve ser uma palavra só, começando com letra ou número e sem espaços; os únicos placeholders permitidos são {id} e {subject}",
      true,
    ],
    ["group", isText, NOT_EMPTY, true],
    ["parallel", isCount, "deve ser um inteiro positivo", true],
    ["maxActive", isCount, "deve ser um inteiro positivo", true],
    ["resume", (value) => typeof value === "boolean", "só pode ser true ou false", true],
    ["tell", (value) => TELLS.includes(value as string), `só pode ser ${TELLS.join(", ")}`, true],
    ["emits", isObject, "deve ser um objeto", true],
    ["channels", isSomeWords, "deve ser uma lista de identificadores de canal", true],
  ]);
  if (isObject(when) && "source" in when) {
    checkFields(issues, `${where}no when, `, when, [
      ["source", isKeyOf(rules.sources), `não é uma fonte registrada: ${when.source}`],
      ["types", isTypes, "deve ser uma lista de tipos de evento; pode usar x.* ou *"],
    ]);
  } else if (isObject(when)) {
    if (isCron(when.cron) && nextRun(parseCron(when.cron as string)!, now, rules.timezone) === null) {
      issues.push(`${where}o agendamento nunca chega: ${when.cron}`);
    }
    checkFields(issues, `${where}no when, `, when, [["cron", isCron, "não é um cron válido"]]);
  }
  if (!isObject(rule)) return;
  // Um comando puro não precisa de palavras: um script que consulta algo de tempos em tempos também é um Agent.
  if (!rule.skill && !rule.prompt && rules.agents[rule.to]?.use !== "command") {
    issues.push(`${where}escreva pelo menos um entre skill e prompt`);
  }
  if (isObject(rule.emits)) {
    const emittable: Check = (value) => value !== SCHEDULE && isKeyOf(rules.sources)(value);
    checkFields(issues, `${where}no emits, `, rule.emits, [
      ["source", emittable, `não é uma fonte registrada: ${rule.emits.source}`],
      ["types", isTypes, "deve ser uma lista de tipos de evento"],
    ]);
  }
  for (const channel of isSomeWords(rule.channels) ? (rule.channels as string[]) : []) {
    if (!Object.hasOwn(rules.channels, channel))
      issues.push(`${where}o campo channels tem um canal não registrado: ${channel}`);
  }
  rule.group ??= rule.name;
  rule.tell ??= "needed";
}

export function parseRules(json: string, now: number, timezone: string): Rules {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new RulesError([`não é JSON: ${(error as Error).message}`]);
  }
  const issues: string[] = [];
  checkFields(issues, "o rules.json: ", parsed, [
    ["timezone", isZone, "não é um fuso horário válido", true],
    ["askFirst", isWords, "deve ser uma lista de textos", true],
    ["sources", isObject, "deve ser um objeto"],
    ["agents", isObject, "deve ser um objeto"],
    ["channels", isObject, "deve ser um objeto", true],
    ["defaultChannels", isSomeWords, "deve ser uma lista de identificadores de canal", true],
    ["rules", Array.isArray, "deve ser uma lista"],
    ["elsewhere", Array.isArray, "deve ser uma lista", true],
  ]);
  if (issues.length) throw new RulesError(issues);
  const rules = parsed as Rules;
  rules.timezone ??= timezone;
  rules.askFirst ??= ASK_FIRST;
  rules.channels ??= {};
  rules.elsewhere ??= [];
  if (SCHEDULE in rules.sources) issues.push(`a fonte ${SCHEDULE} é reservada: agendamentos usam o cron da regra`);
  for (const [id, source] of Object.entries(rules.sources)) {
    if (!ID.test(id)) issues.push(`o identificador da fonte ${ID_WORDS}: ${id}`);
    checkFields(issues, `a fonte ${id}: `, source, [
      ["name", isText, NOT_EMPTY],
      ["adapter", isText, NOT_EMPTY, true],
    ]);
  }
  rules.sources[SCHEDULE] = { name: "agendamento" };
  for (const [id, channel] of Object.entries(rules.channels)) {
    if (!ID.test(id)) issues.push(`o identificador do canal ${ID_WORDS}: ${id}`);
    checkFields(issues, `o canal ${id}: `, channel, [
      ["name", isText, NOT_EMPTY],
      ["answerers", isWords, "deve ser uma lista de textos", true],
      ["links", (value) => typeof value === "boolean", "deve ser true ou false", true],
    ]);
  }
  for (const channel of rules.defaultChannels ?? []) {
    if (!Object.hasOwn(rules.channels, channel))
      issues.push(`o campo defaultChannels do rules.json tem um canal não registrado: ${channel}`);
  }
  for (const [id, agent] of Object.entries(rules.agents)) {
    if (!ID.test(id)) issues.push(`o identificador do Agent ${ID_WORDS}: ${id}`);
    checkFields(issues, `o Agent ${id}: `, agent, [
      ["name", isText, NOT_EMPTY],
      ["worker", isId, ID_WORDS],
      ["use", isId, ID_WORDS],
      ["model", isText, NOT_EMPTY, true],
      ["effort", isText, NOT_EMPTY, true],
      ["tier", isText, NOT_EMPTY, true],
      ["access", (value) => ACCESS.includes(value as string), `só pode ser ${ACCESS.join(", ")}`, true],
      ["command", isSomeWords, "deve ser uma lista de comandos", !isObject(agent) || agent.use !== "command"],
      ["program", isText, "deve ser o caminho de um programa", true],
      ["timeout", isCount, "deve ser um inteiro positivo (em minutos)", true],
      ["maxActive", isCount, "deve ser um inteiro positivo", true],
    ]);
    if (isObject(agent)) agent.access ??= "edit";
  }
  const names = new Set<string>();
  for (const rule of rules.rules) checkRule(issues, rules, rule, names, now);
  if (issues.length) throw new RulesError(issues);
  const limits = new Map<string, number | undefined>();
  for (const { group, parallel } of rules.rules) {
    if (limits.has(group) && limits.get(group) !== parallel)
      issues.push(`as regras do grupo "${group}" precisam ter o mesmo parallel`);
    limits.set(group, parallel);
  }
  for (const task of rules.elsewhere) {
    const name = nameOf(task);
    if (names.has(name)) issues.push(`a tarefa agendada "${name}" tem o mesmo nome de outra regra ou tarefa agendada`);
    names.add(name);
    checkFields(issues, `a tarefa agendada "${name}": `, task, [
      ["name", isText, NOT_EMPTY],
      ["source", isKeyOf(rules.sources), "não é uma fonte registrada"],
      ["to", isKeyOf(rules.agents), "não é um Agent registrado"],
      ["cron", isCron, "não é um cron válido"],
      ["where", isText, NOT_EMPTY],
      ["model", isText, NOT_EMPTY, true],
      ["effort", isText, NOT_EMPTY, true],
      ["cwd", isFolder, FOLDER, true],
      ["skill", isText, NOT_EMPTY, true],
      ["prompt", isText, NOT_EMPTY, true],
    ]);
    if (!isObject(task)) continue;
    // As respostas dela seguem como uma rodada de uma regra, então precisam do que uma regra precisa.
    const words = task.skill !== undefined || task.prompt !== undefined;
    if (words && task.cwd === undefined)
      issues.push(`a tarefa agendada "${name}" diz o que fazer depois da resposta: falta o cwd onde continuar`);
    if (task.cwd !== undefined && !words && rules.agents[task.to]?.use !== "command") {
      issues.push(
        `a tarefa agendada "${name}" tem cwd: escreva pelo menos um entre skill e prompt, o que fazer após a resposta`,
      );
    }
  }
  if (issues.length) throw new RulesError(issues);
  return rules;
}
