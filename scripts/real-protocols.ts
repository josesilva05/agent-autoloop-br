// Modos de falha: um adaptador ACP não consegue restaurar a própria sessão; um cliente MCP real não consegue negociar nem
// chamar uma ferramenta da central; um teste de fumaça escreve no home normal da central ou deixa para trás o banco/servidor dela.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, cpus } from "node:os";
import { join } from "node:path";
const mode = process.argv[2];
assert.ok(["acp", "mcp"].includes(mode));
const home = mkdtempSync(join(tmpdir(), `agent-autoloop-real-${mode}-`));
const start = Date.now();
process.env.AGENT_AUTOLOOP_HOME = home;
process.env.AGENT_AUTOLOOP_RULES = join(home, "rules.json");
const execute = (program: string, args: string[], env = process.env) =>
  new Promise<string>((resolve, reject) => {
    execFile(program, args, { cwd: home, env, timeout: 180000, maxBuffer: 8 * 1024 * 1024 }, (error, out, err) =>
      error ? reject(new Error(err || error.message)) : resolve(out),
    ).stdin!.end();
  });
let server: any;
let hub: any;
try {
  if (mode === "acp") {
    assert.ok(process.argv[3], "escreva depois de acp o caminho absoluto do programa do serviço ACP");
    const env = {
      ...process.env,
      INITIAL_AGENT_MODE: "read-only",
      NO_BROWSER: "1",
      CODEX_CONFIG: JSON.stringify({ model: "gpt-6.1-sol", model_reasoning_effort: "low", approval_policy: "never" }),
    };
    let session: string | null = null;
    for (let n = 0; n < 2; n++) {
      const out = await execute(
        process.execPath,
        [
          join(import.meta.dirname, "../plugins/acp/bridge.ts"),
          JSON.stringify({
            cwd: home,
            access: "read",
            prompt: n
              ? "Responda apenas com os quatro dígitos combinados no turno anterior, sem chamar ferramentas."
              : "Memorize os quatro dígitos 7391. Responda apenas com esses quatro dígitos, sem chamar ferramentas.",
            resume: session,
            command: [process.argv[3]],
          }),
        ],
        env,
      );
      const final = out
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
        .at(-1);
      assert.equal(final.finished, true);
      assert.ok(final.text.includes("7391"));
      if (session) assert.equal(final.session, session);
      session = final.session;
    }
    console.log(
      JSON.stringify({ agent: "ACP Codex", turns: 2, resumed: true, machine: cpus()[0].model, ms: Date.now() - start }),
    );
  } else {
    writeFileSync(
      process.env.AGENT_AUTOLOOP_RULES,
      JSON.stringify({ sources: {}, agents: {}, channels: {}, rules: [] }),
    );
    hub = await import("../host/runtime.ts");
    const { serve } = await import("../host/http.ts");
    server = serve(0);
    await once(server, "listening");
    let calls = 0;
    server.on("request", (req: any) => {
      if (req.url === "/v1/state") calls++;
    });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, owner: hub.addKey("owner", "smoke") }),
    );
    const { findProgram } = await import("../worker/agents.ts");
    const codex = findProgram("codex", () => [
      "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
    ]);
    const out = await execute(codex, [
      "exec",
      "--ignore-user-config",
      "--ephemeral",
      "--disable",
      "memories",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "-m",
      "gpt-6.1-sol",
      "-c",
      'model_reasoning_effort="low"',
      "-c",
      'approval_policy="never"',
      "-c",
      `mcp_servers.agent_autoloop.command=${JSON.stringify(process.execPath)}`,
      "-c",
      `mcp_servers.agent_autoloop.args=${JSON.stringify([join(import.meta.dirname, "../bin/agent-autoloop.ts"), "mcp"])}`,
      "-c",
      `mcp_servers.agent_autoloop.env={AGENT_AUTOLOOP_HOME=${JSON.stringify(home)}}`,
      "Você precisa chamar a ferramenta status do agent_autoloop para ver o estado e então responder apenas: Leitura de estado concluída. Não chame outras ferramentas.",
    ]);
    assert.ok(calls > 0);
    assert.ok(out.includes("Leitura de estado concluída"));
    console.log(
      JSON.stringify({
        client: "Codex MCP",
        version: "2025-11-25",
        statusCalls: calls,
        machine: cpus()[0].model,
        ms: Date.now() - start,
      }),
    );
  }
} finally {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  hub?.db.close();
  rmSync(home, { recursive: true, force: true });
}
