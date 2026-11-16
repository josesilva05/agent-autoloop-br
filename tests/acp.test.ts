// Modos de falha: o histórico carregado vira a resposta desta rodada; um bridge reiniciado esquece a sessão do
// Agent; saída de pensamento ou de ferramenta vira recibo; permissões desconhecidas são aprovadas; caminhos escapam
// por symlinks; um erro de RPC parece sucesso; uma rodada que o Agent pegou e depois perdeu não é marcada como
// iniciada, e o worker roda o prompt de novo; uma sessão que não pôde ser carregada é marcada como iniciada, e o
// worker nunca abre uma nova; um Agent recebe um número de versão que um release deixou para trás. Continuando numa
// sessão, uma falha antes do prompt (o programa sai de imediato, o initialize falha, o carregamento se interrompe) é
// tomada por uma sessão em que não dá para continuar, e o trabalho é refeito numa nova; um Agent que recusa a sessão,
// ou que não consegue continuar em nenhuma, não é solto para uma nova; um Agent que só tem session/resume recebe
// session/load; uma sessão que outra coisa tem aberta agora é tomada por uma que o Agent recusou, e o trabalho é
// refeito numa nova. Um U+2028 ou U+2029 em qualquer coisa que o Agent diga, que o JSON deixa como está, corta a
// linha e encerra a rodada. Com acesso de edição, um link na pasta que não leva a nada, ou um caminho que passa por
// um link assim, passa por arquivo novo dentro dela, e escrever através dele cai do lado de fora. Uma solicitação de
// permissão que dá só o id da chamada de ferramenta é julgada como se não tivesse kind; o que uma mensagem anterior
// disse da chamada esconde o que esta diz, ou um campo deixado vazio apaga o que se sabia. Um pensamento no meio de
// uma mensagem perde a primeira metade dela; uma chamada de ferramenta concluída entre duas mensagens sem id as
// junta, e por isso um "FALHOU" depois dela é lido como trabalho feito; uma linha que não dá para ler, que um Agent
// não deve escrever, é deixada passar, e então uma sem quebra de linha leva a resposta junto e a execução fica
// pendurada até o limite de tempo. Uma rodada que falhou não avisa até o Agent e o stdout dele sumirem, o que pode
// nunca acontecer; a resposta escrita pela metade conta; ou o que o próprio Agent disse no stderr se perde do
// motivo. Uma rodada que um Agent real encerra sem texto nenhum — o que o OpenCode 1.1.2 faz quando o modelo que ele
// chamou recusa — é relatada como uma rodada que não terminou: contradiz o stop reason que cita e não aponta causa
// alguma. Um Agent sem linha de comando não diz o que está faltando.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import acp from "../plugins/acp/agent.ts";
import { bridge, permission } from "../plugins/acp/bridge.ts";
import { versionName } from "../host/version.ts";
import { acpAgent } from "./helpers.ts";
const home = mkdtempSync(join(tmpdir(), "agent-autoloop-acp-"));
after(() => rmSync(home, { recursive: true, force: true }));
const fake = join(home, "fake.mjs");
writeFileSync(
  fake,
  `
import readline from 'node:readline';
import { writeFileSync } from 'node:fs';
const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\\n');
const update=(sessionUpdate,text)=>send({method:'session/update',params:{sessionId:'agent-session',update:{sessionUpdate,content:{type:'text',text}}}});
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;
if(m.method==='initialize'){writeFileSync(${JSON.stringify(join(home, "client-version"))},m.params.clientInfo.version);send({id:m.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true}}});}
if(m.method==='session/new')send({id:m.id,result:{sessionId:'agent-session'}});
if(m.method==='session/load'){if(m.params.sessionId!=='agent-session')return send({id:m.id,error:{code:-1,message:'bad session'}});update('agent_message_chunk','histórico antigo');send({id:m.id,result:{}});}
if(m.method==='session/prompt'){if(m.params.prompt[0].text==='interrompido no meio'){update('tool_call','');process.exit(9);}update('agent_thought_chunk','pensando');update('agent_message_chunk','mensagem do meio');update('tool_call','');update('agent_message_chunk',m.params.prompt[0].text);send({id:m.id,result:{stopReason:'end_turn'}});}
});`,
);
const bridged = (command: string[], resume: string | null, prompt = "concluído", access = "read") =>
  new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const child = spawn(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        join(import.meta.dirname, "../plugins/acp/bridge.ts"),
        JSON.stringify({ command, cwd: home, prompt, access, resume }),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (err += b));
    child.on("close", (code) => resolve({ code, out, err }));
  });
const run = (resume: string | null, prompt = "concluído") => bridged([process.execPath, fake], resume, prompt);
/** Uma execução de um Agent substituto. */
const launch = (name: string, script: string, resume: string | null = null, prompt?: string, access?: string) =>
  bridged([process.execPath, acpAgent(home, name, script)], resume, prompt, access);
const refusing = (message: string) =>
  `(m) => send({ id: m.id, error: { code: -32000, message: ${JSON.stringify(message)} } })`;
const declaring = (capabilities: object) =>
  `on.initialize = (m) => send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: ${JSON.stringify(capabilities)} } });`;
test("o ACP fala v1, retoma entre processos, descarta o histórico e devolve só a resposta final", async () => {
  for (const resume of [null, "agent-session"]) {
    const r = await run(resume);
    assert.equal(r.code, 0, r.err);
    const lines = r.out
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.equal(lines.at(-1).text, "concluído");
    assert.equal(lines.at(-1).session, "agent-session");
    assert.ok(!r.out.includes("histórico antigo"));
    assert.ok(!r.out.includes("pensando"));
  }
  const bad = await run("missing-session");
  assert.notEqual(bad.code, 0);
  assert.match(bad.err, /bad session/);
});
test("o ACP diz que a rodada começou quando o Agent tem o prompt, e nunca numa sessão que não carregou", async () => {
  for (const resume of [null, "agent-session"]) {
    const ok = await run(resume);
    assert.equal(
      JSON.parse(ok.out.split("\n")[0]).started,
      true,
      "impresso antes de o prompt ir, então sobrevive a um kill",
    );
    assert.equal(acp.read(ok.out, null, "").started, true);
    assert.equal(acp.read(ok.out, ok.code, ok.err).text, "concluído");
    const lost = await run(resume, "interrompido no meio");
    assert.notEqual(lost.code, 0);
    const reading = acp.read(lost.out, lost.code, lost.err);
    assert.deepEqual(
      [reading.started, reading.session, reading.text],
      [true, "agent-session", undefined],
      "uma rodada quebrada mantém a sessão e não conta como resposta",
    );
    assert.match(reading.error!, /ACP/);
  }
  const missing = await run("missing-session");
  const reading = acp.read(missing.out, missing.code, missing.err);
  assert.equal(reading.started, undefined);
  assert.match(reading.error!, /bad session/);
});
for (const [what, script] of [
  ["sai assim que começa", "process.exit(3);"],
  ["falha ao inicializar", `on.initialize = ${refusing("o initialize quebrou")};`],
  ["fala outra versão", "on.initialize = (m) => send({ id: m.id, result: { protocolVersion: 99 } });"],
  ["sai durante o carregamento da sessão", "on['session/load'] = () => process.exit(4);"],
  [
    "sai durante a retomada da sessão",
    `${declaring({ sessionCapabilities: { resume: {} } })} on['session/resume'] = () => process.exit(4);`,
  ],
] as const) {
  test(`o ACP continuando numa sessão permanece nela quando o Agent ${what}`, async () => {
    const result = await launch(what.replaceAll(" ", "-"), script, "agent-session");
    assert.notEqual(result.code, 0);
    const reading = acp.read(result.out, result.code, result.err);
    assert.deepEqual([reading.started, reading.session], [true, "agent-session"]);
    assert.ok(reading.error);
    assert.equal(acp.read(result.out, null, "").started, true, "e é lido assim enquanto está em curso");
  });
}

test("o ACP continuando numa sessão permanece nela quando o programa não chega a iniciar", async () => {
  const result = await bridged([join(home, "not-there")], "agent-session");
  assert.notEqual(result.code, 0);
  const reading = acp.read(result.out, result.code, result.err);
  assert.deepEqual([reading.started, reading.session], [true, "agent-session"]);
});

test("o ACP só deixa uma sessão nova começar quando o Agent diz não a esta", async () => {
  for (const [name, script, why] of [
    ["refuses-load", `on['session/load'] = ${refusing("essa sessão não existe")};`, /essa sessão não existe/],
    [
      "refuses-resume",
      `${declaring({ sessionCapabilities: { resume: {} } })} on['session/resume'] = ${refusing("essa sessão não existe")};`,
      /essa sessão não existe/,
    ],
    ["cannot-resume", declaring({}), /não permite retomar/],
    // O que o adapter oficial diz de uma sessão que realmente não existe, e o mesmo código de "em uso" por outro motivo.
    [
      "no-rollout",
      `on['session/load'] = (m) => send({ id: m.id, error: { code: -32603, message: 'no rollout found' } });`,
      /no rollout found/,
    ],
    [
      "bad-request",
      `on['session/load'] = (m) => send({ id: m.id, error: { code: -32600, message: 'não aceito', data: { reason: 'other' } } });`,
      /não aceito/,
    ],
  ] as const) {
    const result = await launch(name, script, "agent-session");
    assert.notEqual(result.code, 0);
    const reading = acp.read(result.out, result.code, result.err);
    assert.equal(reading.started, undefined, name);
    assert.match(reading.error!, why);
    assert.equal(acp.read(result.out, null, "").started, undefined, `${name}: e é lido assim enquanto está em curso`);
  }
  const fresh = await launch("fresh-breaks", `on.initialize = ${refusing("o initialize quebrou")};`);
  assert.equal(acp.read(fresh.out, fresh.code, fresh.err).started, undefined, "uma sessão nova não tem onde ficar");
});

test("o ACP permanece numa sessão que outra coisa tem aberta, e diz o motivo com as palavras do Agent", async () => {
  const inUse = `(m) => send({ id: m.id, error: { code: -32600, message: 'esta sessão está aberta em outro lugar, feche e tente de novo', data: { reason: 'thread_active_writer' } } })`;
  for (const [name, script] of [
    ["in-use-load", `on['session/load'] = ${inUse};`],
    ["in-use-resume", `${declaring({ sessionCapabilities: { resume: {} } })} on['session/resume'] = ${inUse};`],
  ] as const) {
    const result = await launch(name, script, "agent-session");
    assert.notEqual(result.code, 0);
    const reading = acp.read(result.out, result.code, result.err);
    assert.deepEqual([reading.started, reading.session], [true, "agent-session"], name);
    assert.match(reading.error!, /esta sessão está aberta em outro lugar, feche e tente de novo/);
  }
});

test("o ACP usa session/resume para um Agent que só tem esse, e session/load para um que tem os dois", async () => {
  const called = join(home, "resume-method");
  const record = `(m) => { appendFileSync(${JSON.stringify(called)}, JSON.stringify([m.method, m.params.sessionId, m.params.cwd, m.params.mcpServers])); send({ id: m.id, result: {} }); }`;
  const both = `on['session/load'] = ${record}; on['session/resume'] = ${record};`;
  const onlyResume = await launch(
    "only-resume",
    `${declaring({ sessionCapabilities: { resume: {} } })} ${both}`,
    "agent-session",
  );
  assert.equal(onlyResume.code, 0, onlyResume.err);
  assert.equal(acp.read(onlyResume.out, onlyResume.code, onlyResume.err).text, "Concluído");
  assert.deepEqual(JSON.parse(readFileSync(called, "utf8")), ["session/resume", "agent-session", home, []]);
  rmSync(called);
  const hasBoth = await launch(
    "has-both",
    `${declaring({ loadSession: true, sessionCapabilities: { resume: {} } })} ${both}`,
    "agent-session",
  );
  assert.equal(hasBoth.code, 0, hasBoth.err);
  assert.deepEqual(JSON.parse(readFileSync(called, "utf8")), ["session/load", "agent-session", home, []]);
});

test("o ACP lê U+2028 e U+2029 no que o Agent diz como parte da linha", async () => {
  const result = await launch(
    "line-separators",
    `on['session/prompt'] = (m) => {
      update({ sessionUpdate: 'tool_call', toolCallId: 't1', kind: 'read', title: 'saída da ferramenta\\u2028segunda linha' });
      say('primeira linha\\u2028segunda linha\\u2029terceira linha');
      send({ id: m.id, result: { stopReason: 'end_turn' } });
    };`,
  );
  assert.equal(result.code, 0, result.err);
  assert.equal(acp.read(result.out, result.code, result.err).text, "primeira linha segunda linha terceira linha");
});

test("o ACP acha onde a última mensagem começa", async () => {
  const tool = (sessionUpdate: string, status?: string) => ({
    sessionUpdate,
    toolCallId: "t",
    title: "ferramenta",
    status,
  });
  const thought = { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "pensando" } };
  const say = (text: string, messageId?: string) => ({ text, messageId });
  for (const [why, steps, expected] of [
    ["um pensamento não divide mensagem com id", [say("começo", "m1"), thought, say("fim", "m1")], "começofim"],
    ["uma chamada também não divide", [say("começo", "m1"), tool("tool_call"), say("fim", "m1")], "começofim"],
    [
      "nem uma concluída divide",
      [say("começo", "m1"), tool("tool_call_update", "completed"), say("fim", "m1")],
      "começofim",
    ],
    ["um id novo é uma mensagem nova", [say("antiga", "m1"), say("nova", "m2")], "nova"],
    ["um id depois de nenhum é uma mensagem nova", [say("antiga"), say("nova", "m2")], "nova"],
    ["sem id, um pensamento é fronteira", [say("antiga"), thought, say("nova")], "nova"],
    ["sem id, uma chamada de ferramenta é fronteira", [say("antiga"), tool("tool_call"), say("nova")], "nova"],
    [
      "sem id, uma chamada concluída é fronteira",
      [say("antiga"), tool("tool_call_update", "completed"), say("nova")],
      "nova",
    ],
    [
      "sem id, uma chamada que falhou é fronteira",
      [say("antiga"), tool("tool_call_update", "failed"), say("nova")],
      "nova",
    ],
    ["uma chamada em curso não é", [say("começo"), tool("tool_call_update", "in_progress"), say("fim")], "começofim"],
    ["nem uma que só reporta", [say("começo"), tool("tool_call_update"), say("fim")], "começofim"],
    ["pedaços sem fronteira são uma mensagem só", [say("um"), say("dois"), say("três")], "umdoistrês"],
  ] as const) {
    const result = await launch(
      `boundary-${why.replaceAll(/\W/g, "-")}`,
      `on['session/prompt'] = (m) => {
        for (const step of ${JSON.stringify(steps)}) {
          if (step.sessionUpdate) update(step);
          else say(step.text, step.messageId);
        }
        send({ id: m.id, result: { stopReason: 'end_turn' } });
      };`,
    );
    assert.equal(result.code, 0, result.err);
    assert.equal(acp.read(result.out, result.code, result.err).text, expected, why);
  }
});

test("o ACP encerra uma rodada assim que não consegue ler uma linha do Agent", async () => {
  for (const [name, stray] of [
    ["a-stray-line", "isto não é JSON\\n"],
    ["a-stray-print-with-no-newline", "isto não é JSON"],
    ["a-blank-line", "\\n"],
    ["a-null", "null\\n"],
  ] as const) {
    // Deixada passar, uma impressão sem quebra de linha leva a resposta junto, e nada encerraria a rodada além deste timer.
    const result = await launch(
      name,
      `setTimeout(() => process.exit(0), 3000);
      on['session/prompt'] = (m) => {
        say('Concluído');
        process.stdout.write('${stray}');
        send({ id: m.id, result: { stopReason: 'end_turn' } });
      };`,
    );
    assert.notEqual(result.code, 0, name);
    const reading = acp.read(result.out, result.code, result.err);
    assert.equal(reading.text, undefined, name);
    assert.doesNotMatch(reading.error!, /saiu antes de devolver/, `${name}: não esperou o Agent sair`);
  }
});

test("o ACP diz que a rodada falhou e o porquê assim que acontece, sem nada esperar o Agent sair", async () => {
  const result = await launch(
    "max-tokens",
    `on['session/prompt'] = (m) => { say('escrito pela metade'); send({ id: m.id, result: { stopReason: 'max_tokens' } }); };`,
  );
  assert.notEqual(result.code, 0);
  const why = "O ACP não concluiu esta rodada: max_tokens";
  assert.deepEqual(JSON.parse(result.out.trim().split("\n").at(-1)!), {
    session: "agent-session",
    finished: true,
    error: why,
  });
  const going = acp.read(result.out, null, "");
  assert.deepEqual([going.finished, going.error, going.text], [true, why, undefined], "dito enquanto ainda está lá");
  // Uma execução que o worker teve de parar depois disso conta como tendo terminado sozinha: ela recebe código 0.
  for (const reading of [
    acp.read(result.out, 0, ""),
    acp.read(result.out, 0, result.err),
    acp.read(result.out, 1, result.err),
  ]) {
    assert.deepEqual([reading.error, reading.session, reading.started], [why, "agent-session", true]);
    assert.equal(reading.text, undefined, "metade de uma resposta não é resposta");
  }
  const talkative = acp.read(result.out, 0, `${result.err}${"ele ainda está escrevendo logs\n".repeat(100)}`);
  assert.ok(talkative.error!.endsWith(why), "um Agent que continua falando não empurra o motivo para fora");
});

test("o ACP diz que uma rodada voltou vazia, e não que ela não terminou", async () => {
  // O OpenCode 1.1.2 responde end_turn sem nada dito quando o modelo que ele chamou recusa o pedido, então o motivo era
  // lido como "não concluiu esta rodada: end_turn" — contradizendo o stop reason que cita e sem apontar causa alguma.
  const result = await launch(
    "empty-answer",
    `on['session/prompt'] = (m) => send({ id: m.id, result: { stopReason: 'end_turn' } });`,
  );
  assert.notEqual(result.code, 0, "uma rodada sem resposta não é uma rodada concluída");
  const reading = acp.read(result.out, result.code, result.err);
  assert.equal(reading.text, undefined);
  assert.match(reading.error!, /não devolveu texto/);
  assert.doesNotMatch(reading.error!, /não concluiu esta rodada/, "ela terminou; só não disse nada");
});

test("o motivo de falha do ACP mantém o que o próprio Agent disse", async () => {
  const result = await launch(
    "says-why",
    `on['session/prompt'] = () => { console.error('o login expirou'); process.exit(1); };`,
  );
  const reading = acp.read(result.out, result.code, result.err);
  assert.match(reading.error!, /o login expirou/);
  assert.match(reading.error!, /O ACP saiu antes de devolver o resultado: 1/);
});

test("o ACP não inventa uma sessão para uma rodada que falhou antes de ter uma", async () => {
  const result = await launch("no-session", `on['session/new'] = ${refusing("não dá para abrir")};`);
  assert.deepEqual(JSON.parse(result.out.trim()), { finished: true, error: "não dá para abrir" });
  const bad = await launch("bad-session", `on['session/new'] = (m) => send({ id: m.id, result: { sessionId: 7 } });`);
  assert.deepEqual(JSON.parse(bad.out.trim()), {
    finished: true,
    error: "o ACP não devolveu um identificador de sessão",
  });
});

test("o ACP escolhe só uma permissão de uma vez e respeita kinds estruturados e caminhos resolvidos", () => {
  const options = [
    { optionId: "always", kind: "allow_always" },
    { optionId: "once", kind: "allow_once" },
    { optionId: "no", kind: "reject_once" },
  ];
  const ask = (access: string, toolCall: any) => permission({ access, cwd: home } as any, { options, toolCall });
  assert.equal(ask("read", { kind: "read" }).outcome, "selected");
  assert.equal(ask("read", { kind: "execute", title: "ler arquivo" }).optionId, "no");
  assert.equal(ask("edit", { kind: "edit", locations: [{ path: join(home, "new.txt") }] }).optionId, "once");
  mkdirSync(join(home, "work"));
  symlinkSync(tmpdir(), join(home, "work", "escape"));
  assert.equal(
    ask("edit", { kind: "edit", locations: [{ path: join(home, "work", "escape", "outside") }] }).optionId,
    "no",
  );
  assert.equal(ask("edit", { kind: "other" }).optionId, "no");
  assert.equal(ask("full", { kind: "other" }).optionId, "once");
});

test("o ACP não toma um link que não leva a nada por um arquivo novo na pasta", () => {
  const options = [
    { optionId: "once", kind: "allow_once" },
    { optionId: "no", kind: "reject_once" },
  ];
  const work = join(home, "links");
  const outside = join(home, "outside");
  mkdirSync(work);
  mkdirSync(outside);
  const edit = (path: string, access = "edit") =>
    permission({ access, cwd: work } as any, { options, toolCall: { kind: "edit", locations: [{ path }] } }).optionId;
  symlinkSync(join(outside, "not-there"), join(work, "dangling"));
  symlinkSync(join(outside, "no-such-dir"), join(work, "dangling-dir"));
  symlinkSync(join(work, "dangling"), join(work, "link-to-dangling"));
  symlinkSync(join(work, "link-to-dangling"), join(work, "link-to-link"));
  symlinkSync("../outside/relative", join(work, "relative-dangling"));
  symlinkSync(join(work, "loop-b"), join(work, "loop-a"));
  symlinkSync(join(work, "loop-a"), join(work, "loop-b"));
  mkdirSync(join(work, "real"));
  symlinkSync(join(outside, "not-there"), join(work, "real", "deep"));
  for (const path of [
    "dangling",
    "dangling-dir/new.txt",
    "dangling-dir/new/deeper.txt",
    "link-to-dangling",
    "link-to-link",
    "relative-dangling",
    "loop-a",
    "loop-a/new.txt",
    "real/deep",
    "new-folder/../dangling",
  ]) {
    assert.equal(edit(join(work, path)), "no", path);
    assert.equal(edit(`${work}/${path}`), "no", `${path}, não normalizado`);
  }
  // O Win32 normaliza .. antes de percorrer o sistema de arquivos; o POSIX percorre primeiro o link pendurado.
  assert.equal(edit(`${work}/dangling/../inside.txt`), process.platform === "win32" ? "once" : "no");
  assert.equal(edit(join(work, "real", "new-file.txt")), "once", "um arquivo novo continua valendo");
  assert.equal(edit(join(work, "new-folder", "new-file.txt")), "once", "numa pasta nova também");
  assert.equal(edit(join(work, "dangling"), "full"), "once", "full não olha os caminhos");
});
test("o ACP julga a permissão por tudo o que já se disse da chamada, com os campos do pedido primeiro", async () => {
  const inside = join(home, "inside.txt");
  const outside = join(tmpdir(), "outside.txt");
  const call = (toolCallId: string, fields: object) => ({
    sessionUpdate: "tool_call",
    toolCallId,
    title: "ferramenta",
    ...fields,
  });
  const change = (toolCallId: string, fields: object) => ({ sessionUpdate: "tool_call_update", toolCallId, ...fields });
  const location = (path: string) => ({ locations: [{ path }] });
  for (const [why, access, updates, request, expected] of [
    ["só o id", "read", [call("t", { kind: "read" })], { toolCallId: "t" }, "allow"],
    ["kind vindo de uma busca", "read", [call("t", { kind: "search" })], { toolCallId: "t" }, "allow"],
    ["execute continua execute", "read", [call("t", { kind: "execute" })], { toolCallId: "t" }, "reject"],
    ["kind de outra chamada", "read", [call("t", { kind: "read" })], { toolCallId: "other" }, "reject"],
    ["edição dentro", "edit", [call("t", { kind: "edit", ...location(inside) })], { toolCallId: "t" }, "allow"],
    ["edição fora", "edit", [call("t", { kind: "edit", ...location(outside) })], { toolCallId: "t" }, "reject"],
    [
      "kind e lugar em duas mensagens",
      "edit",
      [call("t", { kind: "edit" }), change("t", location(inside))],
      { toolCallId: "t" },
      "allow",
    ],
    [
      "uma atualização move para fora",
      "edit",
      [call("t", { kind: "edit", ...location(inside) }), change("t", location(outside))],
      { toolCallId: "t" },
      "reject",
    ],
    [
      "uma atualização muda o kind",
      "read",
      [call("t", { kind: "read" }), change("t", { kind: "execute" })],
      { toolCallId: "t" },
      "reject",
    ],
    [
      "primeiro o kind do próprio pedido",
      "read",
      [call("t", { kind: "read" })],
      { toolCallId: "t", kind: "execute" },
      "reject",
    ],
    [
      "primeiro o lugar do próprio pedido",
      "edit",
      [call("t", { kind: "edit", ...location(inside) })],
      { toolCallId: "t", ...location(outside) },
      "reject",
    ],
    [
      "campos vazios não mudam nada",
      "edit",
      [call("t", { kind: "edit", ...location(inside) }), change("t", { kind: null, locations: null })],
      { toolCallId: "t", kind: null, locations: null },
      "allow",
    ],
    ["nada conhecido", "read", [], { toolCallId: "t" }, "reject"],
  ] as const) {
    const result = await launch(
      `permission-${why.replaceAll(/\W/g, "-")}`,
      `on['session/prompt'] = async (m) => {
        for (const change of ${JSON.stringify(updates)}) update(change);
        const { outcome } = await ask(${JSON.stringify(request)});
        say(outcome.optionId);
        send({ id: m.id, result: { stopReason: 'end_turn' } });
      };`,
      null,
      undefined,
      access,
    );
    assert.equal(result.code, 0, result.err);
    assert.equal(acp.read(result.out, result.code, result.err).text, expected, why);
  }
});

test("o ACP lembra o que o próprio pedido de permissão disse da chamada", async () => {
  const result = await launch(
    "permission-twice",
    `on['session/prompt'] = async (m) => {
      const first = await ask({ toolCallId: 't', kind: 'read' });
      const second = await ask({ toolCallId: 't' });
      say(first.outcome.optionId + ' ' + second.outcome.optionId);
      send({ id: m.id, result: { stopReason: 'end_turn' } });
    };`,
  );
  assert.equal(acp.read(result.out, result.code, result.err).text, "allow allow");
});

test("o ACP não conta chamadas de ferramenta do histórico que carrega como desta rodada", async () => {
  const result = await launch(
    "permission-history",
    `on['session/load'] = (m) => {
      update({ sessionUpdate: 'tool_call', toolCallId: 'old', title: 'antiga', kind: 'read' });
      send({ id: m.id, result: {} });
    };
    on['session/prompt'] = async (m) => {
      const { outcome } = await ask({ toolCallId: 'old' });
      say(outcome.optionId);
      send({ id: m.id, result: { stopReason: 'end_turn' } });
    };`,
    "agent-session",
  );
  assert.equal(acp.read(result.out, result.code, result.err).text, "reject");
});

test("o ACP recusa versões incompatíveis e saída prematura do processo", async () => {
  const original = await import("node:fs").then((fs) => fs.readFileSync(fake, "utf8"));
  try {
    writeFileSync(fake, original.replace("protocolVersion:1", "protocolVersion:99"));
    assert.notEqual((await run(null)).code, 0);
    writeFileSync(fake, "process.exit(0)");
    assert.notEqual((await run(null)).code, 0);
  } finally {
    writeFileSync(fake, original);
  }
});

test("o Agent é informado de que versão é esta", async () => {
  await run(null);
  assert.equal(readFileSync(join(home, "client-version"), "utf8"), versionName());
});

test("pelo ACP, um Agent sem linha de comando diz o que está faltando", async () => {
  const turn = {
    prompt: "",
    session: "",
    resume: null,
    cwd: home,
    access: "read",
    contextFile: "",
    folder: "",
  } as const;
  await assert.rejects(bridge(turn), /O ACP precisa do comando de inicialização em command/);
});
