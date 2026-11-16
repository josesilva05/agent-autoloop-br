// Modos de falha: revisões vazias ou que falharam passam; findings não tratados são atestados; o Codex lê configuração de
// desenvolvedor ou memórias, grava arquivos, vê credenciais ou executa programas/configurações de um PR. A revisão recebe um instantâneo em texto;
// o que um octopus merge traz nunca chega ao revisor, então passa sem ser visto; o Git escapa um caminho com acentos, que não corresponde
// a nenhum padrão; um arquivo na raiz com nome de commit é confundido com um e a revisão não consegue terminar; um shim de npm do Windows não consegue iniciar o revisor.
// Revisores por Agent: a isenção de um Agent deixa passar um caminho revisado em profundidade, ou uma revisão pedida por label; uma mudança que ninguém
// declarou, ou declarada por uma conta em que o projeto não confia ou para outro PR, fica com o revisor listado para aquele Agent; um commit
// novo ou um conflito resolvido à mão mantém a declaração do commit anterior, enquanto uma sincronização limpa com a main a perde;
// o modelo e a profundidade definidos para um revisor nunca chegam ao Codex; uma declaração que a própria conta retirou ainda conta; um caminho que o
// Git imprime entre aspas não corresponde a nenhum padrão, então a mudança de um Agent isento num caminho revisado em profundidade é mesclada sem revisão.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseReview, codexCommand, declaredAgent, depth, reviewDelivery } from "../plugins/delivery/review.ts";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settings } from "../plugins/delivery/project.ts";

/** Exercita a entrada de revisão de produção com as respostas do GitHub mantidas em memória. */
function reviewPullRequest(
  repo: string,
  snapshot: string,
  main: string,
  head: string,
  config: ReturnType<typeof settings>,
  source: { agent: string | null; required: boolean } = { agent: null, required: false },
) {
  const pr = { number: 7, head: { sha: head }, labels: source.required ? [{ name: "deliver-review" }] : [], body: "" };
  const states = new Map<string, any[]>();
  if (source.agent)
    states.set(head, [
      { context: "delivery-agent/7", state: "success", description: source.agent, creator: { id: 1 } },
    ]);
  return reviewDelivery(repo, snapshot, main, pr, config, {
    api: async (path, body, method) => {
      if (path.startsWith("statuses/")) {
        const sha = path.slice("statuses/".length);
        states.set(sha, [{ ...body, creator: { id: 1 } }, ...(states.get(sha) ?? [])]);
        return {};
      }
      assert.equal(path, "pulls/7");
      if (method === "PATCH") pr.body = body.body;
      return structuredClone(pr);
    },
    statuses: (sha) => states.get(sha) ?? [],
    reviewerId: () => 1,
  });
}
test("uma revisão precisa reportar explicitamente uma lista de findings válida", () => {
  assert.deepEqual(parseReview('{"findings":[]}'), []);
  assert.equal(parseReview('{"findings":[{"title":"erro","text":"aqui os dados se perdem"}]}').length, 1);
  for (const text of ["", "Reviewer failed", "{}", '{"findings":null}', '{"findings":[{}]}'])
    assert.throws(() => parseReview(text));
});
test("o Codex ignora a configuração de desenvolvedor e só lê o instantâneo da revisão", () => {
  const argv = codexCommand("/tmp/snapshot/output.json", "high");
  for (const flag of ["--ignore-user-config", "--ephemeral", "memories", "read-only"]) assert.ok(argv.includes(flag));
  assert.ok(argv.includes('default_permissions="review"'));
  const policy = argv.find((v) => v.startsWith("permissions.review.filesystem="))!;
  assert.match(policy, /workspace_roots/);
  assert.ok(!policy.includes(".codex"));
  assert.ok(!policy.includes(".ssh"));
});
test("a revisão usa os pontos da main e um instantâneo só de texto; documentos internos comuns pulam o revisor", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-autoloop-review-"));
  try {
    const repo = join(root, "repo");
    const snap = join(root, "snapshot");
    mkdirSync(repo);
    mkdirSync(join(repo, "docs"));
    const git = (...a: string[]) =>
      execFileSync("git", a, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const commit = () => {
      git("add", "-A");
      git("-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-qm", "test");
      return git("rev-parse", "HEAD");
    };
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "AGENTS.md"), "## Pontos de revisão\nmain-points\n");
    writeFileSync(join(repo, "app.ts"), "throw new Error('must not execute');");
    const main = commit();
    const reviewer = join(root, "reviewer.mjs");
    const called = join(root, "called");
    writeFileSync(
      reviewer,
      `import fs from 'node:fs';let input='';for await(const b of process.stdin)input+=b;if(!input.includes('main-points'))process.exit(1);fs.writeFileSync(${JSON.stringify(called)},'yes');console.log('{"findings":[]}');`,
    );
    const shim = join(root, "reviewer.cmd");
    if (process.platform === "win32") writeFileSync(shim, '@ECHO off\r\nnode "%~dp0reviewer.mjs" %*\r\n');
    const s = settings({
      repo: "example/app",
      internal: ["docs/*.md"],
      review: { points: "AGENTS.md", command: process.platform === "win32" ? [shim] : [process.execPath, reviewer] },
    });
    writeFileSync(join(repo, "docs/a.md"), "docs");
    const docs = commit();
    assert.deepEqual(await reviewPullRequest(repo, snap, main, docs, s), { docsOnly: true });
    assert.ok(!existsSync(called));
    writeFileSync(join(repo, "AGENTS.md"), "## Pontos de revisão\nbranch-points\n");
    writeFileSync(join(repo, "app.ts"), "throw new Error('changed');");
    const head = commit();
    assert.deepEqual(await reviewPullRequest(repo, snap, main, head, s), []);
    assert.ok(existsSync(called));
    assert.deepEqual(readdirSync(join(snap, "1")), ["changes.txt"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
/** Um projeto com um commit na main, e revisores substitutos que deixam uma marca quando são chamados e não encontram nada. */
function project(review: (stand: (name: string) => string[]) => object = () => ({})) {
  const root = mkdtempSync(join(tmpdir(), "agent-autoloop-review-"));
  const repo = join(root, "repo");
  mkdirSync(join(repo, "docs"), { recursive: true });
  const stand = (name: string) => {
    const reviewer = join(root, `${name}.mjs`);
    const mark = JSON.stringify(join(root, name));
    writeFileSync(reviewer, `import fs from 'node:fs';fs.writeFileSync(${mark},'yes');console.log('{"findings":[]}');`);
    return [process.execPath, reviewer];
  };
  const git = (...a: string[]) =>
    execFileSync("git", a, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const identity = ["-c", "user.name=test", "-c", "user.email=test@example.invalid"];
  const commit = () => {
    git("add", "-A");
    git(...identity, "commit", "-qm", "test");
    return git("rev-parse", "HEAD");
  };
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "AGENTS.md"), "## Pontos de revisão\nmain-points\n");
  writeFileSync(join(repo, "app.ts"), "export const version = 1;\n");
  const main = commit();
  const config = settings({
    repo: "example/app",
    internal: ["docs/*.md"],
    review: { points: "AGENTS.md", command: stand("called"), ...review(stand) },
  });
  const snapshot = join(root, "snapshot");
  return {
    repo,
    main,
    git,
    identity,
    commit,
    write: (name: string, content: string) => {
      mkdirSync(join(repo, name, ".."), { recursive: true });
      writeFileSync(join(repo, name), content);
    },
    review: (head: string, source?: { agent: string | null; required: boolean }) =>
      reviewPullRequest(repo, snapshot, main, head, config, source),
    changes: () => readFileSync(join(snapshot, "1", "changes.txt"), "utf8"),
    reviewed: (name = "called") => existsSync(join(root, name)),
    [Symbol.dispose]: () => rmSync(root, { recursive: true, force: true }),
  };
}
test("um branch com octopus merge é reportado, e não revisado sem o que o merge trouxe", async () => {
  using p = project();
  for (const name of ["one", "two"]) {
    p.git("switch", "-q", "-c", name, "main");
    p.write(`${name}.txt`, name);
    p.commit();
  }
  p.git("switch", "-q", "-c", "topic", "main");
  p.write("topic.txt", "topic");
  p.commit();
  p.git(...p.identity, "merge", "-q", "--no-commit", "one", "two");
  p.write("app.ts", "export const version = 'slipped in by the merge';\n");
  const head = p.commit();
  assert.equal(p.git("rev-list", "--parents", "-n1", head).split(" ").length, 4);
  const result = await p.review(head);
  assert.ok("blocked" in result);
  assert.match(result.blocked, /octopus merge/);
  assert.ok(!p.reviewed());
});
test("um merge comum ainda vai para o revisor", async () => {
  using p = project();
  p.git("switch", "-q", "-c", "one", "main");
  p.write("one.txt", "one");
  p.commit();
  p.git("switch", "-q", "-c", "topic", "main");
  p.write("two.txt", "two");
  p.commit();
  p.git(...p.identity, "merge", "-q", "--no-edit", "one");
  assert.deepEqual(await p.review(p.git("rev-parse", "HEAD")), []);
  assert.ok(p.reviewed());
});
test("um caminho com acentos ainda corresponde às configurações", async () => {
  using p = project();
  p.write("docs/instruções.md", "docs");
  assert.deepEqual(await p.review(p.commit()), { docsOnly: true });
  assert.ok(!p.reviewed());
});
test("um arquivo na raiz com nome de commit é revisado como arquivo", async () => {
  using p = project();
  p.write("a".repeat(40), "named like a commit");
  assert.deepEqual(await p.review(p.commit()), []);
  assert.ok(p.reviewed());
  assert.match(p.changes(), /named like a commit/);
});
test("a mudança de um Agent isento pula o revisor, a menos que uma revisão seja pedida ou que ela toque um caminho revisado em profundidade", async () => {
  const exempt = () => ({ agents: { codex: null }, trusted: [1], xhigh: ["ops/*"] });
  using p = project(exempt);
  p.write("app.ts", "export const version = 2;\n");
  const head = p.commit();
  assert.deepEqual(await p.review(head, { agent: "codex", required: false }), { exempt: "codex" });
  assert.ok(!p.reviewed());
  assert.deepEqual(await p.review(head, { agent: "codex", required: true }), []);
  assert.ok(p.reviewed());
  using q = project(exempt);
  q.write("ops/deploy.sh", "echo deploy\n");
  assert.deepEqual(await q.review(q.commit(), { agent: "codex", required: false }), []);
  assert.ok(q.reviewed());
});
test("uma mudança vai para o revisor listado para o seu Agent; uma que ninguém declarou, ou de um Agent não listado, vai para o padrão", async () => {
  const listed = (stand: (name: string) => string[]) => ({
    agents: { claude: { command: stand("for-claude") } },
    trusted: [1],
  });
  using p = project(listed);
  p.write("app.ts", "export const version = 2;\n");
  const head = p.commit();
  await p.review(head, { agent: "claude", required: false });
  assert.ok(p.reviewed("for-claude") && !p.reviewed());
  await p.review(head, { agent: "gemini", required: false });
  assert.ok(p.reviewed());
  using q = project(listed);
  q.write("app.ts", "export const version = 2;\n");
  await q.review(q.commit());
  assert.ok(q.reviewed() && !q.reviewed("for-claude"));
});
test("o modelo e a profundidade definidos para um revisor chegam ao Codex, e um caminho revisado em profundidade eleva a profundidade", () => {
  const argv = codexCommand("/tmp/snapshot/output.json", "xhigh", "another-model");
  assert.equal(argv[argv.indexOf("-m") + 1], "another-model");
  assert.ok(argv.includes('model_reasoning_effort="xhigh"'));
  assert.equal(depth(undefined, false), "high");
  assert.equal(depth("medium", false), "medium");
  assert.equal(depth("medium", true), "xhigh");
  assert.equal(depth("max", true), "max");
});
test("só a declaração de uma conta confiável para este PR nomeia o Agent, neste commit ou naquele em que uma sincronização limpa com a main o deixou", () => {
  using p = project();
  const status = (change = {}) => ({
    context: "delivery-agent/7",
    state: "success",
    description: "codex",
    creator: { id: 1 },
    ...change,
  });
  const on =
    (commit: string, entry = status()) =>
    (sha: string) =>
      sha === commit ? [entry] : [];
  const agent = (head: string, statuses: (sha: string) => any[], main = p.main) =>
    declaredAgent(p.repo, main, head, 7, [1], statuses);
  p.git("switch", "-q", "-c", "side", "main");
  p.write("side.txt", "side");
  p.commit();
  p.git("switch", "-q", "-c", "topic", "main");
  p.write("app.ts", "export const version = 2;\n");
  const own = p.commit();
  assert.equal(agent(own, on(own)), "codex");
  for (const wrong of [
    { creator: { id: 2 } },
    { context: "delivery-agent/8" },
    { state: "pending" },
    { description: "Não É Um Nome" },
  ])
    assert.equal(agent(own, on(own, status(wrong))), null);
  const tookBack = (sha: string) => (sha === own ? [status({ state: "failure" }), status()] : []);
  assert.equal(agent(own, tookBack), null);
  p.write("more.txt", "more");
  const next = p.commit();
  assert.equal(agent(next, on(own)), null);
  p.git(...p.identity, "merge", "-q", "--no-edit", "side");
  assert.equal(agent(p.git("rev-parse", "HEAD"), on(next)), null);
  p.git("reset", "-q", "--hard", next);
  p.git("switch", "-q", "main");
  p.write("other.txt", "other");
  const moved = p.commit();
  p.git("switch", "-q", "topic");
  p.git(...p.identity, "merge", "-q", "--no-edit", "main");
  const synced = p.git("rev-parse", "HEAD");
  assert.equal(agent(synced, on(next), moved), "codex");
  const tookBackAfter = (sha: string) => (sha === synced ? [status({ state: "failure" })] : on(next)(sha));
  assert.equal(agent(synced, tookBackAfter, moved), null);
  p.git("reset", "-q", "--hard", next);
  p.git("switch", "-q", "main");
  p.write("app.ts", "export const version = 3;\n");
  const clashing = p.commit();
  p.git("switch", "-q", "topic");
  assert.throws(() => p.git(...p.identity, "merge", "-q", "--no-edit", "main"));
  p.write("app.ts", "export const version = 4;\n");
  assert.equal(agent(p.commit(), on(next), clashing), null);
});
test(
  "um caminho que o Git imprime entre aspas ainda é um que o projeto revisa em profundidade",
  { skip: process.platform === "win32" && "O Windows não tem nomes de arquivo com aspas" },
  async () => {
    using p = project(() => ({ agents: { codex: null }, trusted: [1], xhigh: ["ops/*"] }));
    p.write('ops/de"ploy.sh', "echo deploy\n");
    assert.deepEqual(await p.review(p.commit(), { agent: "codex", required: false }), []);
    assert.ok(p.reviewed());
  },
);
