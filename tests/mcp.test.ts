// Modos de falha: stdout contém texto que não é do protocolo; ferramentas desconhecidas executam endpoints arbitrários;
// argumentos malformados chegam à central; uma falha HTTP vira um resultado de ferramenta bem-sucedido; notificações recebem
// respostas; chaves de fonte atuam como chaves de titular; um cliente recebe um número de versão deixado para trás por uma
// release; uma chamada de ferramenta lenta segura um ping ou outra chamada, ou é descartada quando a entrada termina com ela
// em andamento; um U+2028 ou U+2029 numa requisição, que o JSON deixa como está, corta a linha, então a requisição nunca
// recebe resposta. Um Agent perguntando por MCP vê só a página mais nova de rodadas e não consegue voltar além dela.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createServer, type RequestListener } from "node:http";
import { versionName } from "../host/version.ts";
import { setup } from "./helpers.ts";
const home = setup("mcp");

/** O servidor MCP de verdade, contra uma central de faz de conta, passado o handshake. */
async function connect(hub: RequestListener) {
  const server = createServer(hub);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      url: `http://127.0.0.1:${(server.address() as any).port}`,
      owner: "owner-key",
      source: { name: "app", key: "source-key" },
    }),
  );
  const child = spawn(process.execPath, ["bin/agent-autoloop.ts", "mcp"], {
    cwd: join(import.meta.dirname, ".."),
    env: process.env,
    stdio: ["pipe", "pipe", "inherit"],
  });
  // Observado desde o início: ele pode já ter ido embora quando um teste olhar.
  const closed = once(child, "close");
  let output = "";
  child.stdout.on("data", (b) => (output += b));
  const answers = () =>
    output
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const send = (message: object) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  const answered = async (id: number) => {
    const end = Date.now() + 5_000;
    for (;;) {
      const answer = answers().find((answer) => answer.id === id);
      if (answer) return answer;
      if (Date.now() > end) assert.fail(`nada voltou para ${id}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const close = async () => {
    child.kill();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
  send({
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  });
  send({ method: "notifications/initialized" });
  await answered(1);
  return { child, closed, send, answers, answered, close };
}

test("o MCP por stdio inicializa e expõe só as operações tipadas da central", async () => {
  const calls: any[] = [];
  const server = createServer((req, res) => {
    calls.push([req.url, req.headers.authorization]);
    res.statusCode = req.url?.includes("999") ? 404 : 200;
    res.end(JSON.stringify({ ok: true }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      url: `http://127.0.0.1:${(server.address() as any).port}`,
      owner: "owner-key",
      source: { name: "app", key: "source-key" },
    }),
  );
  const child = spawn(process.execPath, ["bin/agent-autoloop.ts", "mcp"], {
    cwd: join(import.meta.dirname, ".."),
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let err = "";
  child.stdout.on("data", (b) => (output += b));
  child.stderr.on("data", (b) => (err += b));
  const messages = [
    {
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    },
    { method: "notifications/initialized" },
    { id: 2, method: "tools/list" },
    { id: 3, method: "tools/call", params: { name: "status", arguments: {} } },
    { id: 4, method: "tools/call", params: { name: "why", arguments: { run: -1 } } },
    { id: 5, method: "tools/call", params: { name: "why", arguments: { run: 999 } } },
    { id: 6, method: "tools/call", params: { name: "request", arguments: { path: "/etc/passwd" } } },
    { id: 7, method: "tools/call", params: { name: "emit", arguments: { id: "a", type: "one" } } },
    {
      id: 8,
      method: "tools/call",
      params: { name: "pause", arguments: { rule: "inspeção", reason: "o upstream está em manutenção" } },
    },
    { id: 9, method: "tools/call", params: { name: "resume", arguments: { rule: "inspeção" } } },
    {
      id: 10,
      method: "tools/call",
      params: { name: "run", arguments: { rule: "inspeção", reason: "dar uma olhada" } },
    },
    {
      id: 11,
      method: "tools/call",
      params: { name: "replay", arguments: { rule: "inspeção", since: "2026-11-11T08:59:12.345Z" } },
    },
  ];
  child.stdin.end(messages.map((m) => JSON.stringify({ jsonrpc: "2.0", ...m })).join("\n") + "\n");
  await once(child, "close");
  server.close();
  assert.equal(child.exitCode, 0, err);
  const responses = output
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.equal(responses.length, 11);
  assert.equal(
    responses[0].result.serverInfo.version,
    versionName(),
    "ele diz qual versão é, não um número deixado para trás",
  );
  const get = (id: number) => responses.find((r) => r.id === id);
  assert.equal(get(1).result.protocolVersion, "2025-11-25");
  for (const name of ["answer", "pause", "resume", "run", "replay"])
    assert.ok(get(2).result.tools.some((t: any) => t.name === name));
  assert.equal(get(3).result.isError, undefined);
  assert.equal(get(4).error.code, -32602);
  assert.equal(get(5).result.isError, true);
  assert.equal(get(6).error.code, -32602);
  // As chamadas rodam lado a lado, então podem chegar à central em qualquer ordem.
  assert.deepEqual(calls.toSorted(), [
    ["/v1/events", "Bearer source-key"],
    ["/v1/rules/inspe%C3%A7%C3%A3o/pause", "Bearer owner-key"],
    ["/v1/rules/inspe%C3%A7%C3%A3o/replay", "Bearer owner-key"],
    ["/v1/rules/inspe%C3%A7%C3%A3o/resume", "Bearer owner-key"],
    ["/v1/rules/inspe%C3%A7%C3%A3o/run", "Bearer owner-key"],
    ["/v1/runs/999/why", "Bearer owner-key"],
    ["/v1/state", "Bearer owner-key"],
  ]);
});

test("status volta uma página de rodadas quando recebe before", async () => {
  const urls: string[] = [];
  const mcp = await connect((req, res) => {
    urls.push(req.url!);
    res.end(JSON.stringify({ ok: true }));
  });
  mcp.send({ id: 2, method: "tools/call", params: { name: "status", arguments: { before: 41 } } });
  assert.equal((await mcp.answered(2)).result.isError, undefined);
  await mcp.close();
  assert.deepEqual(urls, ["/v1/state?before=41"]);
});

test("U+2028 e U+2029 numa requisição fazem parte da linha", async () => {
  let told = "";
  const mcp = await connect(async (req, res) => {
    for await (const chunk of req) told += chunk;
    res.end(JSON.stringify({ ok: true }));
  });
  try {
    const text = "primeira linha\u2028segunda linha\u2029terceira linha";
    mcp.send({ id: 2, method: "tools/call", params: { name: "tell", arguments: { key: "k", text } } });
    assert.equal((await mcp.answered(2)).result.isError, undefined);
    assert.deepEqual(JSON.parse(told), { key: "k", text });
    assert.ok(!mcp.answers().some((answer) => answer.error), "e nenhum pedaço dele foi tomado por requisição");
  } finally {
    await mcp.close();
  }
});

test("uma chamada de ferramenta lenta não segura nem um ping nem outra chamada, e ainda é respondida depois que a entrada termina", async () => {
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const mcp = await connect(async (req, res) => {
    if (req.url === "/v1/state") await held;
    res.end(JSON.stringify({ asked: req.url }));
  });
  try {
    mcp.send({ id: 2, method: "tools/call", params: { name: "status", arguments: {} } });
    mcp.send({ id: 3, method: "ping" });
    assert.deepEqual((await mcp.answered(3)).result, {});
    mcp.send({ id: 4, method: "tools/call", params: { name: "why", arguments: { run: 1 } } });
    assert.match((await mcp.answered(4)).result.content[0].text, /runs\/1\/why/);
    assert.ok(!mcp.answers().some((answer) => answer.id === 2), "ela ainda está com a central");
    mcp.child.stdin.end();
    release();
    assert.match((await mcp.answered(2)).result.content[0].text, /v1\/state/);
    await mcp.closed;
    assert.equal(mcp.child.exitCode, 0);
  } finally {
    release();
    await mcp.close();
  }
});
