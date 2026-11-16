// `agent-autoloop mcp`: as portas da central expostas como ferramentas MCP por stdio, usando as chaves que já estão no
// config.json desta máquina.
import { readConfig } from "../host/config.ts";
import { eachLine } from "../host/lines.ts";
import { versionName } from "../host/version.ts";
import { hubClient, type Hub } from "../protocol/client.ts";

const positive = { type: "integer", minimum: 1 };
const string = { type: "string", minLength: 1 };
const specs = [
  [
    "status",
    "Consulta os assuntos e cartões atuais; em before informe o nextBefore da página anterior para voltar a rodadas mais antigas",
    { before: positive },
    [],
  ],
  ["why", "Consulta os eventos, a regra e o resultado de uma rodada", { run: positive }, ["run"]],
  [
    "answer",
    "Responde a um cartão; as opções começam em 0, e você também pode escrever a sua própria resposta",
    { card: positive, choice: { type: "integer", minimum: 0 }, text: string },
    ["card"],
  ],
  [
    "resolve",
    "Encerra um cartão informando o resultado verificado",
    { card: positive, reason: string },
    ["card", "reason"],
  ],
  ["stop", "Interrompe uma rodada", { run: positive }, ["run"]],
  [
    "emit",
    "Envia um evento com a fonte desta máquina; o mesmo identificador é registrado uma única vez",
    { id: string, type: string, subject: string, summary: string, detail: string, link: string },
    ["id", "type"],
  ],
  [
    "tell",
    "Envia uma notificação com a fonte desta máquina; o mesmo identificador é enviado uma única vez",
    { key: string, text: string },
    ["key", "text"],
  ],
  [
    "pause",
    "Pausa uma regra: não dispara no horário agendado e não recebe nem enfileira eventos; os eventos ignorados não são repostos automaticamente, são listados na retomada manual e depois podem ser reexecutados com replay",
    { rule: string, reason: string, until: string },
    ["rule"],
  ],
  [
    "resume",
    "Retoma uma regra pausada e lista na resposta os eventos ignorados durante a pausa (paused.skipped)",
    { rule: string },
    ["rule"],
  ],
  [
    "replay",
    "Reexecuta os eventos que uma regra ignorou desde since durante a pausa, cada um uma única vez; use o paused.since da resposta do resume",
    { rule: string, since: string },
    ["rule", "since"],
  ],
  ["run", "Executa imediatamente uma rodada de uma regra", { rule: string, subject: string, reason: string }, ["rule"]],
] as const;

const usesSourceKey = (name: string) => ["emit", "tell"].includes(name);

function toolsFor(config: ReturnType<typeof readConfig>) {
  return specs
    .filter(([name]) => (usesSourceKey(name) ? config.source : config.owner))
    .map(([name, description, properties, required]) => ({
      name,
      description,
      inputSchema: { type: "object", properties, required, additionalProperties: false },
      annotations: { readOnlyHint: ["status", "why"].includes(name), destructiveHint: name === "stop" },
    }));
}
type Tool = ReturnType<typeof toolsFor>[number];

function validArguments(tool: Tool, args: any) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  if (!tool.inputSchema.required.every((key) => Object.hasOwn(args, key))) return false;
  const properties = tool.inputSchema.properties as Record<string, any>;
  const fits = ([key, value]: [string, unknown]) => {
    const schema = properties[key];
    if (!schema) return false;
    if (schema.type === "integer") return Number.isSafeInteger(value) && (value as number) >= schema.minimum;
    return typeof value === "string" && value.trim().length > 0;
  };
  if (!Object.entries(args).every(fits)) return false;
  return tool.name !== "answer" || (args.choice !== undefined) !== (args.text !== undefined);
}

function callTool(hub: Hub, name: Tool["name"], args: any) {
  switch (name) {
    case "status":
      return hub.state(args.before);
    case "why":
      return hub.why(args.run);
    case "answer": {
      const { card, ...answer } = args;
      return hub.answer(card, answer);
    }
    case "resolve":
      return hub.resolve(args.card, args.reason);
    case "stop":
      return hub.cancel(args.run);
    case "emit":
      return hub.event(args);
    case "tell":
      return hub.tell(args);
    case "pause":
      return hub.pause(args.rule, {
        ...(args.reason !== undefined && { reason: args.reason }),
        ...(args.until !== undefined && { until: args.until }),
      });
    case "resume":
      return hub.resume(args.rule);
    case "replay":
      return hub.replay(args.rule, { since: args.since });
    case "run":
      return hub.run(args.rule, {
        ...(args.subject !== undefined && { subject: args.subject }),
        ...(args.reason !== undefined && { reason: args.reason }),
      });
  }
}

export async function mcp() {
  const config = readConfig();
  const tools = toolsFor(config);
  const reply = (id: unknown, body: object) => console.log(JSON.stringify({ jsonrpc: "2.0", id, ...body }));
  const refuse = (id: unknown, code: number, message: string) => reply(id, { error: { code, message } });

  async function answerCall(id: unknown, params: any) {
    const tool = tools.find((tool) => tool.name === params?.name);
    const args = params?.arguments ?? {};
    if (!tool || !validArguments(tool, args)) return refuse(id, -32602, "Nome de ferramenta ou argumentos inválidos");
    const hub = hubClient(config.url, usesSourceKey(tool.name) ? config.source!.key : config.owner!);
    try {
      const result = await callTool(hub, tool.name, args);
      reply(id, { result: { content: [{ type: "text", text: JSON.stringify(result) }] } });
    } catch (error) {
      reply(id, { result: { isError: true, content: [{ type: "text", text: (error as Error).message }] } });
    }
  }

  eachLine(process.stdin, (line) => {
    let request: any;
    try {
      request = JSON.parse(line);
    } catch {
      return refuse(null, -32700, "não é JSON");
    }
    if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      return refuse(request?.id ?? null, -32600, "Formato de solicitação inválido");
    }
    const { id, method, params } = request;
    if (id === undefined) return;
    if (method === "initialize") {
      const serverInfo = { name: "agent-autoloop", version: versionName() };
      reply(id, { result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo } });
    } else if (method === "ping") reply(id, { result: {} });
    else if (method === "tools/list") reply(id, { result: { tools } });
    // Cada chamada responde por si, por mais que demore: o ping do cliente tem de conseguir passar nesse meio tempo.
    else if (method === "tools/call") void answerCall(id, params);
    else refuse(id, -32601, "Método inexistente");
  });
}
