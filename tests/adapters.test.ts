// O que difere em cada Agent. Casos de falha: um nível de acesso mapeia para a flag errada, acesso total é dado sem
// ninguém pedir, uma nova tentativa começa outra conversa em vez de continuar, um erro ou uma rodada que nunca terminou
// conta como resposta, uma reconexão que o Codex anunciou e superou antes de a rodada terminar faz a execução concluída
// falhar, um aviso do programa é tomado pela resposta dele, uma execução concluída do Claude impressa como um array JSON
// só é lida como falha, a sessão não é identificada, um placeholder da linha de comando não é preenchido, ou uma execução
// do Codex em segundo plano presume que herdou a conexão de navegador de um aplicativo. Uma rodada que começou e então
// quebrou, ou foi morta antes de terminar, não diz que começou, então o worker roda o prompt dela de novo; uma que nunca
// chegou a começar diz que começou, então o worker não abre uma sessão nova para ela; o que o Claude disse antes de uma
// tarefa em segundo plano terminar é tomado como resposta dele, ou inicia a espera por uma rodada que não vai sair; as
// mensagens brutas de uma execução quebrada do Claude viram o motivo da falha. Um recibo que um Agent escreveu e depois
// perdeu porque uma tarefa em segundo plano o chamou de volta para outra rodada é descartado, então o cartão que ele pediu
// nunca existe e o trabalho parece intocado; ou, vindo junto, substitui um que a última rodada escreveu errado, e uma
// revisão cancelada volta. Os tokens do Claude deixam de fora o que ele leu do próprio cache enquanto os dos outros contam,
// então o mesmo trabalho aparece como uma fração do Codex. Uma linha de saída que é JSON mas não é mensagem, como `null`,
// impede um plugin de ler qualquer coisa. A passada de placeholders da linha de comando reescreve o próprio prompt — um
// `{cwd}` ou um `$&` que a pessoa escreveu chega como a pasta ou como `{prompt}` —, então se pede ao programa algo
// diferente do que o evento disse. Um Agent embutido inicia o programa que encontra, não o que suas regras nomeiam, então
// um wrapper que manda o Claude Code para outro serviço nunca roda. Um tier de serviço que as regras nomeiam para o Codex
// nunca chega à linha de comando dele, então a execução usa o tier que a configuração de Codex da máquina tiver naquele
// dia. Um programa que some por um momento, como enquanto uma atualização o reinstala, continua sumido até o worker
// reiniciar.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";
import { readMessage, resultFrom } from "../worker/contract.ts";

process.env.PATH = `/nonexistent:${process.env.PATH}`;
const { findProgram } = await import("../worker/agents.ts");
// A construção da linha de comando também precisa rodar em máquinas de CI sem o Codex instalado.
const shell = process.env.SHELL;
const lookup = join(setup("adapters"), "lookup.sh");
writeFileSync(lookup, '#!/bin/sh\nprintf "%s\\n" /test/codex\n', { mode: 0o755 });
process.env.SHELL = lookup;
findProgram("codex");
if (shell === undefined) delete process.env.SHELL;
else process.env.SHELL = shell;
type Adapter = import("../worker/agents.ts").Adapter;
const claude: Adapter = (await import("../plugins/claude/agent.ts")).default;
const codex: Adapter = (await import("../plugins/codex/agent.ts")).default;
const command: Adapter = (await import("../plugins/command/agent.ts")).default;
const dsh: Adapter = (await import("../plugins/dsh/agent.ts")).default;
const zcode: Adapter = (await import("../plugins/zcode/agent.ts")).default;

const turn = {
  prompt: "faça isso",
  session: "new-id",
  resume: null,
  cwd: "/x",
  access: "edit" as const,
  contextFile: "/ctx.json",
  folder: "/run",
};
const has = (argv: string[], ...parts: string[]) => {
  const at = argv.indexOf(parts[0]);
  return at >= 0 && parts.every((part, i) => argv[at + i] === part);
};

// O programa em si é buscado uma vez só: estes só se importam com o que vem depois dele.
const stubbed = (adapter: Adapter, t: object) => {
  try {
    return adapter.command({ ...turn, ...t });
  } catch {
    return null;
  }
};

test("um Agent embutido inicia o programa que suas regras nomeiam, com os argumentos dele depois", () => {
  for (const adapter of [claude, codex, dsh, zcode]) {
    const argv = adapter.command({ ...turn, program: "/opt/bin/via-gateway" });
    assert.equal(argv[0], "/opt/bin/via-gateway");
    assert.ok(argv.includes("faça isso") || argv.some((part) => part.includes("faça isso")), "o prompt ainda entra");
  }
});

test("Claude Code: acesso, sessão nova e continuada, modelo", { skip: !stubbed(claude, {}) }, () => {
  const argv = stubbed(claude, {})!;
  assert.ok(has(argv, "-p", "faça isso"));
  assert.ok(has(argv, "--session-id", "new-id"));
  assert.ok(has(argv, "--permission-mode", "acceptEdits"));
  // Tem que imprimir conforme avança: como "json" nada sai até o fim, e uma interrompida não deixa rastro.
  assert.ok(has(argv, "--output-format", "stream-json"));
  assert.ok(argv.includes("--verbose"), "o Claude Code recusa stream-json no modo de impressão sem ele");
  assert.ok(!argv.includes("--model"));
  assert.ok(has(stubbed(claude, { access: "read" })!, "--permission-mode", "plan"));
  assert.ok(has(stubbed(claude, { access: "full" })!, "--permission-mode", "bypassPermissions"));
  const again = stubbed(claude, { resume: "old-id", model: "m", effort: "high" })!;
  assert.ok(has(again, "--resume", "old-id"));
  assert.ok(!again.includes("--session-id"));
  assert.ok(has(again, "--model", "m"));
  assert.ok(has(again, "--effort", "high"));
});

test("Claude Code: lendo o resultado dele", () => {
  const line = (over: object) =>
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "pronto",
      session_id: "s",
      total_cost_usd: 0.5,
      usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 5, cache_creation_input_tokens: 1 },
      ...over,
    });
  assert.deepEqual(claude.read(`noise\n${line({})}\n`, 0, ""), {
    text: "pronto",
    session: "s",
    usage: { input: 16, output: 2, cached: 5 },
    sessionUsage: { cost: 0.5 },
    finished: true,
  });
  assert.match(
    claude.read(line({ is_error: true, result: "Failed to authenticate\nmore" }), 1, "").error!,
    /^Failed to authenticate$/,
  );
  assert.equal(claude.read(line({ is_error: true, result: "x" }), 1, "").session, "s");
  assert.equal(claude.read(line({ subtype: "error_max_turns", result: undefined }), 1, "").error, "error_max_turns");
  // Com verbose ligado, o Claude Code imprime cada mensagem como um array JSON numa linha só.
  const array = `[{"type":"system","subtype":"init"},{"type":"assistant"},${line({})}]\n`;
  assert.equal(claude.read(array, 0, "").text, "pronto");
  assert.deepEqual(claude.read("", null, ""), {}, "ainda em andamento");
  assert.equal(claude.read("", 1, "boom").error, "boom");
  assert.equal(claude.read("", 0, "").error, "não deixou resultado");
  assert.equal(claude.link!("s"), "claude://resume?session=s");
});

// O que `claude -p --output-format stream-json --verbose` realmente imprime, reduzido ao que é lido.
const stream = (...messages: object[]) => `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`;
const init = { type: "system", subtype: "init", session_id: "s" };
const hook = { type: "system", subtype: "hook_started", session_id: "s" };
const thinking = { type: "assistant", session_id: "s", message: { content: [{ type: "thinking" }] } };
const tool = { type: "assistant", session_id: "s", message: { content: [{ type: "tool_use", name: "Bash" }] } };
const toolResult = { type: "user", session_id: "s", message: { content: [{ type: "tool_result", content: "senha" }] } };
const said = (result: string, num_turns = 1) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result,
  num_turns,
  session_id: "s",
});
const tasks = (...running: string[]) => ({
  type: "system",
  subtype: "background_tasks_changed",
  tasks: running.map((task_id) => ({ task_id, task_type: "local_bash" })),
  session_id: "s",
});

test("Claude Code: uma rodada que começou diz isso, seja como for que terminou", () => {
  const cut = stream(hook, init, tool, toolResult);
  assert.deepEqual(claude.read(cut, null, ""), { session: "s", started: true }, "ainda em andamento, ou sumiu");
  const killed = claude.read(cut, 143, "");
  assert.equal(killed.session, "s");
  assert.equal(killed.started, true);
  assert.equal(killed.error, "não deixou resultado");
  assert.equal(claude.read(stream(init), null, "").started, true, "ele tem o prompt, numa conversa que existe");
  const failed = { ...said("API Error: 500"), is_error: true };
  assert.equal(claude.read(stream(init, thinking, failed), 1, "").started, true);
  assert.equal(claude.read(stream(failed), 1, "").started, true, "só a última linha, e ele fez uma rodada");
  assert.equal(claude.read(stream(init, tool, said("pronto", 2)), 0, "").text, "pronto");
});

test("Claude Code: um resume que nunca começou não diz que começou, e diz o porquê", () => {
  const missing = {
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    num_turns: 0,
    session_id: "old",
    errors: ["No conversation found with session ID: old"],
  };
  const reading = claude.read(stream(missing), 1, "No conversation found with session ID: old");
  assert.equal(reading.started, undefined);
  assert.equal(reading.error, "No conversation found with session ID: old");
  assert.equal(claude.read("", 1, "No conversation found").started, undefined, "impresso como json: nada no stdout");
  assert.equal(claude.read(stream(hook), 1, "boom").started, undefined, "um hook roda antes de ele ter o prompt");
  assert.deepEqual(claude.read(stream(hook), null, ""), { session: "s" });
});

test("Claude Code: as mensagens brutas de uma execução quebrada não são o motivo da falha", () => {
  assert.equal(claude.read(stream(init, tool, toolResult), 1, "a conexão caiu").error, "a conexão caiu");
  assert.doesNotMatch(claude.read(stream(init, tool, toolResult), 1, "").error!, /senha|tool_result/);
  assert.equal(
    claude.read("Invalid API key\n", 1, "").error,
    "Invalid API key",
    "a reclamação dele no stdout também conta",
  );
});

test("Claude Code: o que ele disse antes de uma tarefa em segundo plano terminar não é a resposta", () => {
  const waiting = stream(init, tool, tasks("t1"), toolResult, said("iniciado", 2));
  assert.deepEqual(claude.read(waiting, null, ""), { session: "s", started: true }, "ainda rodando, não acabou");
  assert.equal(claude.read(waiting, 137, "").text, undefined, "morto enquanto esperava: nunca chegou à resposta");
  assert.equal(claude.read(waiting, 137, "").error, "não deixou resultado");
  assert.equal(claude.read(waiting, 0, "").text, "iniciado", "terminou por conta própria: foi a última palavra dele");
  const ended = stream(init, tool, tasks("t1"), toolResult, said("iniciado", 2), tasks());
  assert.equal(claude.read(ended, null, "").finished, true, "não sobrou nada que o faça voltar");
  assert.equal(claude.read(ended, null, "").text, "iniciado");
  for (const next of [init, thinking, toolResult]) {
    const going = stream(init, tool, tasks("t1"), toolResult, said("iniciado", 2), tasks(), next);
    assert.deepEqual(claude.read(going, null, ""), { session: "s", started: true }, "outra rodada em andamento");
    assert.equal(claude.read(going, 1, "").error, "não deixou resultado", "e ela quebrou");
  }
  const done = stream(init, tool, tasks("t1"), said("iniciado", 2), tasks(), init, thinking, said("terminou"));
  assert.equal(claude.read(done, null, "").finished, true);
  assert.equal(claude.read(done, 0, "").text, "terminou");
});

test("Claude Code: um recibo escrito não se perde quando uma tarefa em segundo plano o chama de volta", () => {
  const block = (receipt: object) => "```agent-autoloop\n" + JSON.stringify(receipt) + "\n```";
  const ask = { title: "corrigir?", text: "corrige este defeito?", options: ["sim", "não"], recommend: 0, key: "k" };
  // A tarefa termina depois da resposta, então o Claude Code é chamado de volta para outra rodada que não fala do ask.
  const called = stream(
    init,
    tool,
    tasks("t1"),
    toolResult,
    said(`verifiquei; aguardando a sua decisão.\n\n${block({ ask: [ask] })}`, 30),
    tasks(),
    init,
    tool,
    said("NADA A FAZER: o cartão já foi enviado"),
  );
  const read = claude.read(called, 0, "");
  assert.ok(read.text!.startsWith("NADA A FAZER: o cartão já foi enviado"), "a última rodada ainda é a resposta");
  const handed = resultFrom(readMessage(read.text!), {});
  assert.equal(handed.problem, undefined, "e é entregue como um recibo que a central consegue ler");
  assert.deepEqual(handed.result.ask, [ask]);
  assert.equal(handed.result.outcome, "nothing", "as palavras da própria última rodada decidem o resultado");
  // Chamado de volta mais de uma vez, o último recibo que ele escreveu é o que ainda conta.
  const twice = stream(
    init,
    said(`primeira\n\n${block({ notice: [{ title: "aviso antigo", text: "notificação antiga" }] })}`),
    init,
    said(`segunda\n\n${block({ notice: [{ title: "aviso novo", text: "notificação nova" }] })}`),
    init,
    said("NADA A FAZER: todos já foram enviados"),
  );
  const notices = (text: string) => readMessage(text).receipt?.notice as { title: string; text: string }[] | undefined;
  assert.equal(notices(claude.read(twice, 0, "").text!)?.[0].title, "aviso novo");
  // O recibo dele próprio não é substituído por um mais antigo, e sem nenhum antes nada é inventado.
  const own = stream(
    init,
    said(`primeira\n\n${block({ notice: [{ title: "aviso antigo", text: "notificação antiga" }] })}`),
    init,
    said(`última\n\n${block({ later: [{ key: "c", at: "2026-11-08T09:00:00+08:00", about: "reverificação" }] })}`),
  );
  const kept = readMessage(claude.read(own, 0, "").text!).receipt as {
    notice?: unknown;
    later?: { key: string }[];
  };
  assert.equal(kept.later?.[0].key, "c", "ele mantém o recibo da própria última rodada");
  assert.equal(kept.notice, undefined, "e nenhum mais antigo é acrescentado ao lado");
  assert.equal(claude.read(stream(init, said("primeira"), init, said("última")), 0, "").text, "última");
  // Uma última rodada que escreveu um recibo errado é chamada a escrevê-lo de novo, não recebe um antigo no lugar.
  const earlier = said(
    `primeira\n\n${block({ later: [{ key: "c", at: "2026-11-08T09:00:00+08:00", about: "reverificação" }] })}`,
  );
  const mislabelled = "última\n\n```json\n" + JSON.stringify({ later: [{ key: "c", cancel: true }] }) + "\n```";
  const unclosed = "última\n\n```agent-autoloop\n" + JSON.stringify({ later: [{ key: "c", cancel: true }] }) + "```";
  for (const last of [mislabelled, unclosed]) {
    const message = readMessage(claude.read(stream(init, earlier, init, said(last)), 0, "").text!);
    assert.equal(message.receipt, undefined, "o recibo mais antigo fica no lugar do que ele errou");
    assert.ok(message.problem, "e não lhe é pedido que escreva o próprio de novo");
  }
});

test("Codex: acesso, sessão nova e continuada", { skip: !stubbed(codex, {}) }, () => {
  const argv = stubbed(codex, {})!;
  assert.deepEqual(argv.slice(1, 4), ["exec", "--json", "--skip-git-repo-check"]);
  assert.ok(argv.at(-1)!.endsWith("faça isso"));
  assert.ok(argv.includes('sandbox_mode="workspace-write"'));
  assert.ok(argv.includes('approval_policy="never"'));
  assert.ok(stubbed(codex, { access: "read" })!.includes('sandbox_mode="read-only"'));
  assert.ok(stubbed(codex, { access: "full" })!.includes('sandbox_mode="danger-full-access"'));
  const again = stubbed(codex, { resume: "thread-1", model: "m", effort: "xhigh", tier: "priority" })!;
  assert.deepEqual(again.slice(1, 3), ["exec", "resume"]);
  assert.equal(again.at(-2), "thread-1");
  assert.equal(again.at(-1), argv.at(-1));
  assert.ok(has(again, "-m", "m"));
  assert.ok(again.includes('model_reasoning_effort="xhigh"'));
  assert.ok(again.includes('service_tier="priority"'));
  assert.ok(stubbed(codex, { tier: "priority" })!.includes('service_tier="priority"'), "nova execução também recebe");
  assert.ok(!argv.some((part) => part.startsWith("service_tier")), "fica com a configuração do Codex, salvo regra");
});

test("Codex: execuções novas e continuadas usam só o navegador configurado para a tarefa em segundo plano", () => {
  for (const resume of [null, "thread-1"]) {
    const prompt = codex.command({ ...turn, resume }).at(-1)!;
    assert.match(prompt, /codex exec em segundo plano/);
    assert.match(prompt, /ferramentas de navegador realmente disponíveis nesta rodada/);
    assert.match(prompt, /entrada de navegador.*na regra ou no Skill/);
    assert.match(prompt, /aplicativo desktop.*conexão de navegador/);
    assert.match(prompt, /negócio.*recibo.*rodada/);
    assert.ok(prompt.endsWith(turn.prompt));
    assert.doesNotMatch(prompt, /~\/\.local\/bin\/|\/Users\//);
  }
});

test("Codex: só a última mensagem de uma rodada concluída é a resposta", () => {
  const lines = (...events: object[]) => events.map((e) => JSON.stringify(e)).join("\n");
  const started = { type: "thread.started", thread_id: "t" };
  const warning = { type: "item.completed", item: { type: "error", message: "under development" } };
  const said = (text: string) => ({ type: "item.completed", item: { type: "agent_message", text } });
  const ended = { type: "turn.completed", usage: { input_tokens: 9, cached_input_tokens: 3, output_tokens: 1 } };
  assert.deepEqual(codex.read(lines(started, warning, said("parcial"), said("pronto"), ended), 0, ""), {
    session: "t",
    text: "pronto",
    finished: true,
    sessionUsage: { input: 9, output: 1, cached: 3 },
  });
  // Uma reconexão que o Codex anunciou e então superou (ele caiu para outro transporte e seguiu adiante) não é como a
  // rodada terminou: doze execuções concluídas com recibos foram descartadas e refeitas por causa de uma dessas.
  const reconnect = { type: "error", message: "Reconnecting... 5/5 (request timed out)" };
  assert.deepEqual(codex.read(lines(started, reconnect, said("pronto"), ended), 0, ""), {
    session: "t",
    text: "pronto",
    finished: true,
    sessionUsage: { input: 9, output: 1, cached: 3 },
  });
  assert.deepEqual(
    codex.read(lines(started, said("parcial")), null, ""),
    { session: "t" },
    "ainda em andamento: só a sessão até aqui",
  );
  assert.equal(
    codex.read(lines(started, said("parcial")), 1, "").error,
    "o Codex não concluiu nem deixou um resultado",
  );
  assert.equal(
    codex.read(lines(started, ended), 0, "").error,
    "o Codex não concluiu nem deixou um resultado",
    "terminou sem nada a dizer",
  );
  assert.deepEqual(codex.read(lines(started, { type: "turn.failed", error: { message: "a cota acabou" } }), 1, ""), {
    session: "t",
    finished: true,
    error: "a cota acabou",
  });
  assert.equal(codex.read("", 1, "cannot resume: active writer").error, "cannot resume: active writer");
  assert.equal(codex.link!("t"), "codex://threads/t");
});

test("Codex: uma rodada que começou diz isso, seja como for que terminou; uma que nunca começou não diz", () => {
  const lines = (...events: object[]) => events.map((event) => JSON.stringify(event)).join("\n");
  const thread = { type: "thread.started", thread_id: "t" };
  const warning = { type: "item.completed", item: { type: "error", message: "under development" } };
  const turn = { type: "turn.started" };
  const running = { type: "item.started", item: { type: "command_execution" } };
  const cut = lines(thread, warning, turn, running);
  assert.deepEqual(codex.read(cut, null, ""), { session: "t", started: true }, "ainda em andamento, ou sumiu");
  assert.deepEqual(codex.read(cut, 143, ""), {
    session: "t",
    started: true,
    error: "o Codex não concluiu nem deixou um resultado",
  });
  assert.equal(codex.read(lines(thread, turn, { type: "turn.failed" }), 1, "").started, true);
  assert.equal(codex.read(lines(thread, warning), 1, "boom").started, undefined, "um aviso não é a rodada");
  const missing = "Error: thread/resume: thread/resume failed: no rollout found for thread id x (code -32600)";
  assert.equal(codex.read("", 1, missing).started, undefined);
  assert.equal(codex.read("", 1, "cannot resume: active writer").started, undefined);
});

test("um comando simples: placeholders preenchidos, stdout é a última mensagem, saída ruim é falha", () => {
  const argv = command.command({
    ...turn,
    model: "m",
    command: ["tool", "--model={model}", "-p", "{prompt}", "--ctx", "{context}"],
  });
  assert.deepEqual(argv, ["tool", "--model=m", "-p", "faça isso", "--ctx", "/ctx.json"]);
  assert.deepEqual(command.read("pronto\n", 0, ""), { text: "pronto\n" });
  assert.deepEqual(command.read("parcial", null, ""), {});
  assert.match(command.read("", 3, "boom").error!, /código de saída 3: boom/);
  assert.equal(command.link, undefined, "ele não tem sessão em que continuar");
});

test("o prompt de um comando simples chega ao programa como foi escrito, seja o que contiver", () => {
  // O prompt é o que alguém pediu; os placeholders são da linha de comando, não das palavras colocadas nela.
  const written = [
    "imprima a palavra {cwd} exatamente assim",
    "o preço é $& reais",
    "os caminhos $` e $' também precisam ficar",
    "{context} e {prompt} são ambos literais",
  ];
  for (const prompt of written) {
    const argv = command.command({ ...turn, prompt, command: ["tool", "-p", "{prompt}"] });
    assert.deepEqual(argv, ["tool", "-p", prompt], `${prompt} foi reescrito ao chegar ao programa`);
  }
  // A linha de comando em si ainda é preenchida, e uma que nomeia o prompt duas vezes o recebe duas vezes.
  const both = command.command({ ...turn, model: "m", command: ["tool", "{prompt}", "{model}"] });
  assert.deepEqual(both, ["tool", "faça isso", "m"]);
});

test("um programa que não está lá diz isso", () => {
  assert.throws(() => findProgram("surely-not-installed-anywhere"), /surely-not-installed-anywhere/);
});

test("um programa que falta numa busca é achado na seguinte assim que volta", () => {
  const program = join(setup("adapters-reinstall"), "reinstalled-agent");
  assert.throws(() => findProgram("reinstalled-agent", () => [program]), /reinstalled-agent/);
  writeFileSync(program, "", { mode: 0o755 });
  assert.equal(
    findProgram("reinstalled-agent", () => [program]),
    program,
  );
});

test("uma linha de saída que é JSON mas não é mensagem é ruído para todo plugin", () => {
  const noise = 'null\n42\n"words"\n[]\n';
  for (const adapter of [claude, codex, command, dsh, zcode]) {
    assert.doesNotThrow(() => adapter.read(noise, null, ""));
    assert.doesNotThrow(() => adapter.read(noise, 0, ""));
  }
});
