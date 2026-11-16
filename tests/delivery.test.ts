// Modos de falha: rótulos ausentes/forks disparam o despacho; checks em draft ou pulados autorizam o merge; um
// push durante a revisão, ou a main avançando depois dos checks, rende uma atestação sem revisão; um merge perdido
// é repetido; o auto-merge sobrevive a uma recusa; o health esconde um Ship falho/inacabado; uma publicação
// posterior altera um handoff já concluído; uma remoção de rótulo bem-sucedida com resposta perdida transforma
// uma implantação concluída numa falha falsa; mudar para só-revisão enquanto os checks rodam ainda assim faz o
// merge do PR; um PR atrás da main encerra a execução depois de pedir uma sincronização e espera passar o atraso
// crescente de novas tentativas da central enquanto a main continua avançando; commits que o GitHub sincronizou
// além da main que foi lida são revisados como se fossem do próprio branch; uma entrega retirada enquanto a main
// segue em frente ainda sincroniza e revisa de novo; as configurações lidas antes de a main avançar decidem o que
// faz uma rodada contra a main mais nova, então um health check acrescentado ali é pulado; outro evento num commit
// com problemas encontrados o revisa de novo, e uma revisão que desta vez não os veja faz o merge dele; problemas
// encontrados deixam de pé uma atestação anterior do commit; um PR com merge e sem o rótulo é acompanhado e
// escrito, então uma publicação que falhe depois transforma uma entrega concluída em falha; um PR que alguém
// mesclou durante a revisão não tem sua publicação acompanhada; logo depois de sair de draft a execução mais nova
// ainda é uma do tempo de draft e vale pelo check completo; um job de matriz nunca corresponde ao nome exigido,
// então um check aprovado espera para sempre; um PR com o destino trocado durante os checks é mesclado no outro
// branch; uma entrega retirada durante os checks deixa seu status pendente para sempre; uma escrita de status que
// falha logo depois dos problemas encontrados fecha o commit para novas revisões sem que ninguém saiba o que foi
// achado; rótulos que só saem em parte deixam um PR com merge travado como falho e sem referência para a nova
// tentativa se guiar, ou deixam um PR de só-revisão com cara de entrega completa que a nova tentativa então
// mescla; uma mudança mesclada sem revisão, pela dispensa do seu Agent, é atestada como revisada, ou passa por
// revisada quando se pede uma revisão enquanto ela espera seu check; uma ferramenta de entrega desatualizada do
// projeto é autorizada a mesclar, e um auto-merge habilitado sobrevive a uma reconfirmação falha dela; uma
// resposta de auto-merge perdida dispara uma segunda mutação; uma resposta de atualização de branch perdida
// ignora o head já sincronizado em vez de continuar o mesmo handoff; um check aceito sem jobs espera por cinco
// novas tentativas de meia hora, ou é reiniciado repetidamente, e então uma execução de draft ou manual autoriza
// o merge.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deliver,
  fullCheck,
  waitLive,
  disableAuto,
  DeliveryRefusal,
  type DeliveryIO,
} from "../plugins/delivery/delivery.ts";
import { settings } from "../plugins/delivery/project.ts";
const config = settings({
  repo: "example/app",
  internal: ["docs/**/*.md"],
  review: { points: "AGENTS.md", status: "my-review" },
  health: {
    url: "https://example.invalid/health",
    field: "commit",
    pattern: "(?P<sha>[0-9a-f]{40})",
    require: { ok: true },
  },
});
const pr = () => ({
  number: 1,
  state: "open",
  draft: false,
  merged_at: null,
  merge_commit_sha: null,
  auto_merge: null,
  labels: [{ name: "deliver" }],
  head: { sha: "head", ref: "branch", repo: { full_name: "example/app" } },
  base: { ref: "main" },
  user: { login: "owner" },
});
const run = (id = 1, head_sha = "merged", status = "completed", conclusion: string | null = "success") => ({
  id,
  head_sha,
  event: "push",
  status,
  conclusion,
  html_url: `https://example.invalid/${id}`,
});
function fixture() {
  const state: any = {
    pr: pr(),
    main: "main",
    reviewed: 0,
    merges: 0,
    statuses: [] as any[],
    writes: [] as string[],
    checks: 0,
  };
  const io: DeliveryIO = {
    async api(path, body, method) {
      if (body || method) {
        state.writes.push(path);
        if (path.startsWith("statuses/")) {
          state.statuses.push({ path, ...body });
          return {};
        }
      }
      const combined = /^commits\/(.+)\/status/.exec(path);
      if (combined)
        return { statuses: state.statuses.filter((s: any) => s.path === `statuses/${combined[1]}`).reverse() };
      if (path === "pulls/1") return structuredClone(state.pr);
      if (path === "git/ref/heads/main") return { object: { sha: state.main } };
      if (path.startsWith("contents/ops/delivery.json"))
        return { content: Buffer.from(JSON.stringify(config)).toString("base64") };
      if (path.startsWith("actions/workflows/check.yml")) {
        state.checks++;
        return { workflow_runs: [{ ...run(1, "head"), event: "pull_request" }] };
      }
      if (path.startsWith("actions/runs/1/jobs"))
        return { jobs: [{ name: "check", conclusion: "success", status: "completed" }] };
      if (path.startsWith("actions/workflows/ship.yml")) return { workflow_runs: [run()] };
      if (path === "pulls/1/ready") {
        state.pr.draft = false;
        return {};
      }
      if (path.startsWith("issues/1/labels/")) return {};
      throw new Error(`unexpected ${path}`);
    },
    async review() {
      state.reviewed++;
      return [];
    },
    async merge() {
      state.merges++;
      state.pr.merged_at = "now";
      state.pr.merge_commit_sha = "merged";
    },
    async disableAuto() {
      state.pr.auto_merge = null;
    },
    async contains(a, b) {
      return a === b || (a === "main" && b === "head");
    },
    async releaseRequired() {
      return true;
    },
    async live() {
      return { sha: "merged", release: "merged" };
    },
    async wait() {
      throw new Error("still waiting");
    },
  };
  return { io, state };
}
test("revisão, check completo, atestação no head exato, merge, Ship e health terminam", async () => {
  const { io, state } = fixture();
  const result = await deliver("example/app", 1, io);
  assert.equal(result.merged, "merged");
  assert.equal(state.reviewed, 1);
  assert.equal(state.merges, 1);
  assert.ok(
    state.statuses.some((s: any) => s.path === "statuses/head" && s.context === "my-review" && s.state === "success"),
  );
  assert.ok(state.statuses.some((s: any) => s.context === "delivery" && s.state === "success"));
});
test("uma mudança dispensada de revisão é mesclada com uma atestação que diz isso", async () => {
  const { io, state } = fixture();
  io.review = async () => ({ exempt: "codex" });
  assert.equal((await deliver("example/app", 1, io)).merged, "merged");
  const attested = state.statuses.find((s: any) => s.context === "my-review");
  assert.equal(attested.state, "success");
  assert.match(attested.description, /codex.*dispensada de revisão/);
});
test("um rótulo ausente ou um PR fechado não inicia nada; forks são recusados", async () => {
  for (const change of [{ labels: [] }, { state: "closed" }]) {
    const { io, state } = fixture();
    Object.assign(state.pr, change);
    await deliver("example/app", 1, io);
    assert.equal(state.reviewed, 0);
    assert.equal(state.merges, 0);
  }
  const { io, state } = fixture();
  state.pr.head.repo.full_name = "fork/app";
  await assert.rejects(() => deliver("example/app", 1, io), /deste repositório/);
  assert.equal(state.reviewed, 0);
});
test("um PR com push durante a revisão não recebe atestação e nunca é mesclado", async () => {
  const { io, state } = fixture();
  io.review = async () => {
    state.pr.head.sha = "someone-else";
    return [];
  };
  await assert.rejects(() => deliver("example/app", 1, io), /commit/);
  assert.equal(state.merges, 0);
  assert.ok(!state.statuses.some((s: any) => s.context === "my-review"));
});
function syncing(io: DeliveryIO, state: any) {
  const api = io.api;
  const parents = new Map<string, string>();
  io.contains = async (a, b) => {
    for (let commit: string | undefined = b; commit; commit = parents.get(commit)) {
      if (commit === a || commit === `synced-${a}` || (a === "main" && commit === "head")) return true;
    }
    return false;
  };
  io.api = async (path, body, method) => {
    if (path === "pulls/1/update-branch") {
      state.writes.push(path);
      parents.set(`synced-${state.main}`, state.pr.head.sha);
      state.pr.head.sha = `synced-${state.main}`;
      return {};
    }
    if (path.startsWith("actions/workflows/check.yml"))
      return { workflow_runs: [{ ...run(1, state.pr.head.sha), event: "pull_request" }] };
    return api(path, body, method);
  };
}
test("uma resposta de atualização de branch perdida depois de aceita é relida e o novo head é revisado", async () => {
  const { io, state } = fixture();
  syncing(io, state);
  state.pr.head.sha = "behind";
  const api = io.api;
  io.api = async (path, body, method) => {
    const result = await api(path, body, method);
    if (path === "pulls/1/update-branch") throw new Error("connection lost");
    return result;
  };
  assert.equal((await deliver("example/app", 1, io)).merged, "merged");
  assert.equal(state.reviewed, 1);
  assert.deepEqual(
    state.writes.filter((path: string) => path.endsWith("/update-branch")),
    ["pulls/1/update-branch"],
  );
  assert.equal(latest(state, "my-review").path, "statuses/synced-main");
});
test("a main que avança após a revisão sincroniza na mesma execução e atesta só o head revisado de novo", async () => {
  const { io, state } = fixture();
  syncing(io, state);
  io.review = async () => {
    if (++state.reviewed === 1) state.main = "new-main";
    return [];
  };
  const result = await deliver("example/app", 1, io);
  assert.equal(result.merged, "merged");
  assert.equal(state.reviewed, 2);
  assert.equal(state.merges, 1);
  assert.deepEqual(
    state.statuses.filter((s: any) => s.context === "my-review").map((s: any) => s.path),
    ["statuses/synced-new-main"],
  );
});
test("uma main que não para de avançar para depois de três rodadas sem mesclar", async () => {
  const { io, state } = fixture();
  syncing(io, state);
  io.review = async () => {
    state.main = `main-${++state.reviewed}`;
    return [];
  };
  await assert.rejects(() => deliver("example/app", 1, io), /main/);
  assert.equal(state.reviewed, 3);
  assert.equal(state.merges, 0);
  assert.ok(!state.statuses.some((s: any) => s.context === "my-review"));
});
test("a revisão deixa de fora o que o GitHub sincronizou além da main que foi pedida", async () => {
  const { io, state } = fixture();
  syncing(io, state);
  const { api, contains } = io;
  // a main segue em frente antes de o GitHub aplicar a atualização, então o novo head traz uma main mais nova do
  // que a lida primeiro.
  io.api = async (path, body, method) => {
    if (path === "pulls/1/update-branch") state.main = "newer";
    return api(path, body, method);
  };
  io.contains = async (a, b) => (a === "main" && b === "synced-newer") || contains(a, b);
  const bases: string[] = [];
  io.review = async (_pr, _config, base) => {
    bases.push(base);
    return [];
  };
  state.pr.head.sha = "behind";
  assert.equal((await deliver("example/app", 1, io)).merged, "merged");
  assert.deepEqual(bases, ["newer"]);
});
test("cada rodada segue as configurações da main contra a qual ela revisa", async () => {
  const { io, state } = fixture();
  syncing(io, state);
  const { api } = io;
  io.api = async (path, body, method) => {
    if (path === "contents/ops/delivery.json?ref=new-main") {
      const changed = { ...config, review: { ...config.review, status: "newer-review" } };
      return { content: Buffer.from(JSON.stringify(changed)).toString("base64") };
    }
    return api(path, body, method);
  };
  io.review = async () => {
    if (++state.reviewed === 1) state.main = "new-main";
    return [];
  };
  assert.equal((await deliver("example/app", 1, io)).merged, "merged");
  assert.deepEqual(
    state.statuses.filter((s: any) => s.context !== "delivery").map((s: any) => s.context),
    ["newer-review"],
  );
});
test("uma entrega retirada enquanto a main segue em frente para sem tocar no branch de novo", async () => {
  const { io, state } = fixture();
  syncing(io, state);
  io.review = async () => {
    state.reviewed++;
    state.main = "new-main";
    state.pr.labels = [];
    return [];
  };
  assert.equal((await deliver("example/app", 1, io)).summary, "o rótulo de entrega foi retirado");
  assert.equal(state.reviewed, 1);
  assert.equal(state.merges, 0);
  assert.ok(!state.writes.includes("pulls/1/update-branch"));
});
test("um PR com o destino trocado durante os checks não é mesclado", async () => {
  const { io, state } = fixture();
  const { api } = io;
  io.api = async (path, body, method) => {
    if (path.startsWith("actions/runs/1/jobs")) state.pr.base.ref = "release";
    return api(path, body, method);
  };
  await assert.rejects(() => deliver("example/app", 1, io), /main/);
  assert.equal(state.merges, 0);
  assert.ok(!state.statuses.some((s: any) => s.context === "my-review"));
});
test("uma entrega retirada durante os checks não deixa seu status pendente", async () => {
  const { io, state } = fixture();
  const phases: string[] = [];
  io.report = (phase) => {
    phases.push(phase);
  };
  const { api } = io;
  io.api = async (path, body, method) => {
    if (path.startsWith("actions/runs/1/jobs")) state.pr.labels = [];
    return api(path, body, method);
  };
  assert.equal((await deliver("example/app", 1, io)).summary, "o rótulo de entrega foi retirado");
  assert.equal(state.merges, 0);
  const last = state.statuses.filter((s: any) => s.context === "delivery").at(-1);
  assert.equal(last.state, "success");
  assert.match(last.description, /retirado/);
  assert.match(last.description, /sem merge/);
  assert.equal(phases.at(-1), "withdrawn");
  assert.ok(!state.statuses.some((s: any) => s.context === "my-review"));
});
test("problemas encontrados e o modo só-revisão param antes do merge", async () => {
  const first = fixture();
  first.io.review = async () => [{ title: "Os dados serão perdidos", text: "Corrija primeiro" }];
  const result = await deliver("example/app", 1, first.io);
  assert.equal(result.findings?.length, 1);
  assert.equal(first.state.merges, 0);
  const second = fixture();
  second.state.pr.labels.push({ name: "deliver-review" });
  assert.equal((await deliver("example/app", 1, second.io)).reviewOnly, true);
  assert.equal(second.state.merges, 0);
});
const latest = (state: any, context: string) => state.statuses.filter((s: any) => s.context === context).at(-1);
const problem = [{ title: "Os dados serão perdidos", text: "Corrija primeiro" }];
test("outro evento num commit com problemas encerra a execução: sem segunda revisão, sem status novo", async () => {
  const { io, state } = fixture();
  io.review = async () => {
    state.reviewed++;
    return problem;
  };
  await deliver("example/app", 1, io);
  const written = state.statuses.length;
  io.review = async () => {
    state.reviewed++;
    return [];
  };
  const again = await deliver("example/app", 1, io);
  assert.equal(state.reviewed, 1);
  assert.equal(state.merges, 0);
  assert.equal(again.findings, undefined);
  assert.equal(state.statuses.length, written);
  assert.equal(latest(state, "delivery").state, "failure");
});
test("um commit novo depois dos problemas é revisado e entregue", async () => {
  const { io, state } = fixture();
  io.review = async () => problem;
  await deliver("example/app", 1, io);
  const { api } = io;
  io.api = async (path, body, method) =>
    path.startsWith("actions/workflows/check.yml")
      ? { workflow_runs: [{ ...run(1, "fixed"), event: "pull_request" }] }
      : api(path, body, method);
  io.contains = async () => true;
  io.review = async () => {
    state.reviewed++;
    return [];
  };
  state.pr.head.sha = "fixed";
  assert.equal((await deliver("example/app", 1, io)).merged, "merged");
  assert.equal(state.reviewed, 1);
});
test("só os problemas param a execução: outra falha no commit não", async () => {
  const { io, state } = fixture();
  state.statuses.push({
    path: "statuses/head",
    context: "delivery",
    state: "failure",
    description: "O check completo não passou",
  });
  assert.equal((await deliver("example/app", 1, io)).merged, "merged");
  assert.equal(state.reviewed, 1);
});
test("um commit com problemas que alguém mesclou à mão ainda segue para o Ship", async () => {
  const { io, state } = fixture();
  io.review = async () => {
    state.reviewed++;
    return problem;
  };
  await deliver("example/app", 1, io);
  Object.assign(state.pr, { state: "closed", merged_at: "other", merge_commit_sha: "merged" });
  assert.equal((await deliver("example/app", 1, io)).merged, "merged");
  assert.equal(state.reviewed, 1);
  assert.equal(latest(state, "delivery").state, "success");
});
test("uma escrita de status que falha nos problemas deixa o commit aberto a uma revisão que os reporta", async () => {
  for (const context of ["delivery", "my-review"]) {
    const { io, state } = fixture();
    io.review = async () => problem;
    const { api } = io;
    let failing = true;
    io.api = async (path, body, method) => {
      if (failing && body?.context === context && body.state === "failure") {
        failing = false;
        throw new Error("HTTP 502");
      }
      return api(path, body, method);
    };
    await assert.rejects(() => deliver("example/app", 1, io), /HTTP 502/);
    assert.deepEqual((await deliver("example/app", 1, io)).findings, problem);
    assert.equal(latest(state, "my-review").state, "failure");
    assert.equal(state.merges, 0);
  }
});
test("os problemas nomeiam o commit em que foram achados", async () => {
  const { io, state } = fixture();
  syncing(io, state);
  state.pr.head.sha = "behind";
  io.review = async () => problem;
  assert.equal((await deliver("example/app", 1, io)).head, "synced-main");
});
test("os problemas substituem uma atestação anterior do mesmo commit", async () => {
  const { io, state } = fixture();
  state.statuses.push({ path: "statuses/head", context: "my-review", state: "success", description: "aprovada" });
  io.review = async () => problem;
  await deliver("example/app", 1, io);
  assert.equal(latest(state, "my-review").state, "failure");
  assert.equal(latest(state, "delivery").state, "failure");
  assert.equal(state.merges, 0);
});
test("só-revisão acrescentada durante os checks para antes da atestação de merge", async () => {
  const { io, state } = fixture();
  const api = io.api;
  io.api = async (...args) => {
    if (args[0].startsWith("actions/workflows/check.yml")) state.pr.labels.push({ name: "deliver-review" });
    return api(...args);
  };
  assert.equal((await deliver("example/app", 1, io)).reviewOnly, true);
  assert.equal(state.merges, 0);
  assert.ok(!state.statuses.some((s: any) => s.context === "my-review"));
});
test("só-revisão pedida enquanto uma dispensada espera o check faz ela ser revisada, não dada como tal", async () => {
  const { io, state } = fixture();
  const api = io.api;
  io.api = async (...args) => {
    if (args[0].startsWith("actions/workflows/check.yml"))
      state.pr.labels = [{ name: "deliver" }, { name: "deliver-review" }];
    return api(...args);
  };
  const asked: boolean[] = [];
  io.review = async (pr) => {
    asked.push(pr.labels.some((label: any) => label.name === "deliver-review"));
    return asked.at(-1) ? [] : { exempt: "codex" };
  };
  assert.equal((await deliver("example/app", 1, io)).reviewOnly, true);
  assert.deepEqual(asked, [false, true]);
  assert.equal(state.merges, 0);
});

test("uma resposta de merge perdida depois de aceita é relida, nunca repetida", async () => {
  const { io, state } = fixture();
  const merge = io.merge;
  io.merge = async (...args) => {
    await merge(...args);
    throw new Error("connection lost");
  };
  assert.equal((await deliver("example/app", 1, io)).merged, "merged");
  assert.equal(state.merges, 1);
});
test("o auto-merge usa o head verificado e relê uma resposta perdida antes de tentar de novo", async () => {
  const { io, state } = fixture();
  const requested: string[] = [];
  io.enableAuto = async (requestedPR) => {
    requested.push(requestedPR.head.sha);
    state.pr.auto_merge = {};
    throw new Error("connection lost");
  };
  io.wait = async () => {
    state.pr.merged_at = "now";
    state.pr.merge_commit_sha = "merged";
  };
  assert.equal((await deliver("example/app", 1, io)).merged, "merged");
  assert.deepEqual(requested, ["head"]);
  assert.equal(state.merges, 0);
});
test("uma ferramenta de entrega atrasada enquanto o auto-merge espera é recusada com ele desativado", async () => {
  const { io, state } = fixture();
  io.enableAuto = async () => {
    state.pr.auto_merge = {};
  };
  io.verifyTools = async () => (state.pr.auto_merge ? "A ferramenta de entrega não é a versão mais recente" : null);
  io.wait = async () => {};
  await assert.rejects(() => deliver("example/app", 1, io), /não é a versão mais recente/);
  assert.equal(state.pr.auto_merge, null);
  assert.equal(state.merges, 0);
});
test("uma publicação sem mudanças implantáveis reporta tanto seu merge quanto o Ship bem-sucedido", async () => {
  const { io, state } = fixture();
  const reported: any[] = [];
  io.report = (phase, head, metadata) => {
    reported.push({ phase, head, ...metadata });
  };
  io.live = async () => ({ sha: "live-before", release: "live-before" });
  io.releaseRequired = async () => false;
  assert.match((await deliver("example/app", 1, io)).summary, /sem publicação necessária/);
  assert.deepEqual(reported.at(-1), { phase: "docs_only", head: "head", merge: "merged", ship: 1 });
  assert.equal(latest(state, "delivery").state, "success");
});
test("a remoção de rótulos relê uma resposta perdida e não reporta uma falha de entrega falsa", async () => {
  const { io, state } = fixture();
  const api = io.api;
  io.api = async (...args) => {
    if (args[0] === "issues/1/labels/deliver") {
      state.pr.labels = [];
      throw new Error("Label does not exist (HTTP 404)");
    }
    return api(...args);
  };
  assert.equal((await deliver("example/app", 1, io)).merged, "merged");
  assert.equal(state.merges, 1);
  const second = fixture();
  const before = second.io.api;
  second.io.api = async (...args) => {
    if (args[0] === "issues/1/labels/deliver") throw new Error("permission denied");
    return before(...args);
  };
  await assert.rejects(() => deliver("example/app", 1, second.io), /permission denied/);
});
/** Aqui os rótulos realmente saem, exceto que um deles falha na primeira vez. */
function labelFailsOnce(io: DeliveryIO, state: any, failing: string) {
  const { api } = io;
  let failed = false;
  io.api = async (path, body, method) => {
    const label = /^issues\/1\/labels\/(.+)$/.exec(path)?.[1];
    if (!label) return api(path, body, method);
    if (label === failing && !failed) {
      failed = true;
      throw new Error("HTTP 502");
    }
    state.pr.labels = state.pr.labels.filter((item: any) => item.name !== label);
    return {};
  };
}
test("um PR com merge cujos rótulos só saíram em parte termina na nova tentativa", async () => {
  for (const failing of ["deliver-attended", "deliver-review", "deliver"]) {
    const { io, state } = fixture();
    state.pr.labels.push({ name: "deliver-attended" }, { name: "deliver-review" });
    Object.assign(state.pr, { state: "closed", merged_at: "before", merge_commit_sha: "merged" });
    labelFailsOnce(io, state, failing);
    await assert.rejects(() => deliver("example/app", 1, io), /HTTP 502/);
    assert.equal((await deliver("example/app", 1, io)).merged, "merged");
    assert.equal(latest(state, "delivery").state, "success");
    assert.deepEqual(state.pr.labels, []);
  }
});
test("um PR de só-revisão cujos rótulos só saíram em parte nunca é mesclado pela nova tentativa", async () => {
  for (const failing of ["deliver-attended", "deliver-review", "deliver"]) {
    const { io, state } = fixture();
    state.pr.labels.push({ name: "deliver-attended" }, { name: "deliver-review" });
    labelFailsOnce(io, state, failing);
    await assert.rejects(() => deliver("example/app", 1, io), /HTTP 502/);
    await deliver("example/app", 1, io);
    assert.equal(state.merges, 0);
    assert.ok(!state.statuses.some((s: any) => s.context === "my-review"));
  }
});
test("um cliente diferente mesclando durante os checks é acompanhado sem uma segunda chamada de merge", async () => {
  const { io, state } = fixture();
  const api = io.api;
  io.api = async (...args) => {
    if (args[0].startsWith("actions/runs/1/jobs")) {
      state.pr.merged_at = "other";
      state.pr.merge_commit_sha = "merged";
    }
    return api(...args);
  };
  assert.equal((await deliver("example/app", 1, io)).merged, "merged");
  assert.equal(state.merges, 0);
});
test("um PR mesclado durante a revisão segue para o Ship", async () => {
  for (const pushed of ["head", "pushed-then-merged"]) {
    const { io, state } = fixture();
    io.review = async () => {
      Object.assign(state.pr, { state: "closed", merged_at: "other", merge_commit_sha: "merged" });
      state.pr.head.sha = pushed;
      return problem;
    };
    const result = await deliver("example/app", 1, io);
    assert.equal(result.merged, "merged");
    assert.equal(state.merges, 0);
    assert.equal(latest(state, "delivery").state, "success");
    assert.ok(!state.statuses.some((s: any) => s.state === "failure"));
  }
});
test("um PR com merge retoma direto no Ship sem revisar nem mesclar de novo", async () => {
  const { io, state } = fixture();
  state.pr.merged_at = "before";
  state.pr.merge_commit_sha = "merged";
  state.pr.state = "closed";
  assert.equal((await deliver("example/app", 1, io)).merged, "merged");
  assert.equal(state.reviewed, 0);
  assert.equal(state.merges, 0);
});
test("PR com merge sem o rótulo é deixado em paz: sem status, e nenhuma publicação depois o reprova", async () => {
  const { io, state } = fixture();
  Object.assign(state.pr, { labels: [], state: "closed", merged_at: "before", merge_commit_sha: "merged" });
  const { api } = io;
  io.api = async (path, body, method) =>
    path.startsWith("actions/workflows/ship.yml")
      ? { workflow_runs: [run(1, "merged", "completed", "failure")] }
      : api(path, body, method);
  assert.equal((await deliver("example/app", 1, io)).summary, "não há rótulo de entrega pendente");
  assert.deepEqual(state.writes, []);
  assert.deepEqual(state.statuses, []);
});
test("só contam o workflow completo mais recente no head exato e o job exigido bem-sucedido", async () => {
  for (const [workflow, job, want] of [
    [run(1, "head"), { name: "draft", conclusion: "success" }, "waiting"],
    [run(1, "old"), { name: "check", conclusion: "success" }, "waiting"],
    [run(1, "head"), { name: "check", conclusion: "skipped" }, "waiting"],
    [run(1, "head", "completed", "failure"), { name: "check", conclusion: "skipped" }, "failed"],
    [run(1, "head"), { name: "check", conclusion: "success", status: "completed" }, "passed"],
  ] as const) {
    const { io } = fixture();
    io.api = async (p) =>
      p.includes("/jobs") ? { jobs: [job] } : { workflow_runs: [{ ...workflow, event: "pull_request" }] };
    assert.equal(await fullCheck("head", config, io), want);
  }
});
/** Um draft cuja execução mais nova passou nos tempos de draft: `next` é a execução que sair de draft inicia,
 * depois de uma espera. */
function draftWithPassedRun(next?: any) {
  const { io, state } = fixture();
  state.pr.draft = true;
  const runs = [{ ...run(1, "head"), event: "pull_request" }];
  const jobsOf: string[] = [];
  const { api } = io;
  io.api = async (path, body, method) => {
    if (path.startsWith("actions/workflows/check.yml")) return { workflow_runs: runs };
    if (path.startsWith("actions/runs/")) {
      jobsOf.push(path);
      return { jobs: [{ name: "check", conclusion: "success", status: "completed" }] };
    }
    return api(path, body, method);
  };
  if (next) {
    io.wait = async () => {
      if (runs.length === 1) runs.push({ ...next, event: "pull_request" });
    };
  }
  return { io, state, jobsOf };
}
test("uma execução dos tempos de draft não vale pelo check completo depois de sair de draft", async () => {
  const { io, state } = draftWithPassedRun();
  await assert.rejects(() => deliver("example/app", 1, io), /still waiting/);
  assert.ok(state.writes.includes("pulls/1/ready"));
  assert.equal(state.merges, 0);
  assert.ok(!state.statuses.some((s: any) => s.context === "my-review"));
});
test("a execução que sair de draft inicia é a que decide, aprovada ou reprovada", async () => {
  const passed = draftWithPassedRun(run(2, "head"));
  assert.equal((await deliver("example/app", 1, passed.io)).merged, "merged");
  assert.deepEqual(passed.jobsOf, ["actions/runs/2/jobs?filter=latest&per_page=100"]);
  const failed = draftWithPassedRun(run(2, "head", "completed", "failure"));
  await assert.rejects(() => deliver("example/app", 1, failed.io), /check/);
  assert.equal(failed.state.merges, 0);
});

function queuedFullCheck(status = "queued", age = 10 * 60_000 + 1, jobs: any[] = []) {
  const { io, state } = fixture();
  state.now = Date.parse("2026-11-12T00:00:00Z");
  state.checkRuns = [
    { ...run(10, "head", status, null), event: "pull_request", created_at: new Date(state.now - age).toISOString() },
  ];
  const checkJobs = new Map([[10, jobs]]);
  const jobsRead: number[] = [];
  io.now = () => state.now;
  const { api } = io;
  io.api = async (path, body, method) => {
    if (path.startsWith("actions/workflows/check.yml")) return { workflow_runs: structuredClone(state.checkRuns) };
    const asked = /^actions\/runs\/(\d+)\/jobs/.exec(path);
    if (asked) {
      jobsRead.push(Number(asked[1]));
      return { jobs: checkJobs.get(Number(asked[1])) ?? [] };
    }
    if (path === "pulls/1/draft") {
      state.writes.push(path);
      state.pr.draft = true;
      return {};
    }
    return api(path, body, method);
  };
  return { io, state, checkJobs, jobsRead };
}
const passedJob = { name: "check", status: "completed", conclusion: "success" };
const stalledReason =
  "O GitHub aceitou o check, mas ele nunca começou (provável incidente); já foi reacionado e segue parado. Reentregue quando o GitHub voltar.";

test("um check aceito e antigo sem jobs é reiniciado uma vez e só sua nova execução pronta pode mesclar", async () => {
  for (const status of ["queued", "waiting", "pending"]) {
    const { io, state, checkJobs, jobsRead } = queuedFullCheck(status);
    const { api } = io;
    io.api = async (path, body, method) => {
      const result = await api(path, body, method);
      if (path === "pulls/1/draft") {
        state.checkRuns.push({ ...run(11, "head"), event: "pull_request" });
        checkJobs.set(11, [passedJob]);
      }
      if (path === "pulls/1/ready") {
        state.checkRuns.push({ ...run(99, "head"), event: "workflow_dispatch" });
        checkJobs.set(99, [passedJob]);
      }
      return result;
    };
    let waits = 0;
    io.wait = async () => {
      assert.equal(state.pr.draft, false);
      assert.ok(state.writes.includes("pulls/1/ready"));
      waits++;
      state.checkRuns.push({ ...run(12, "head"), event: "pull_request" });
      checkJobs.set(12, [passedJob]);
    };
    assert.equal((await deliver("example/app", 1, io)).merged, "merged");
    assert.deepEqual(
      state.writes.filter((path: string) => /\/(draft|ready)$/.test(path)),
      ["pulls/1/draft", "pulls/1/ready"],
    );
    assert.equal(waits, 1);
    assert.deepEqual(jobsRead, [10, 12]);
    assert.deepEqual(io.checkRecovery, { head: "head", after: 11 });
    assert.equal(state.merges, 1);
  }
});

test("um check reiniciado que também trava é recusado na hora, sem uma segunda reinicialização", async () => {
  const { io, state } = queuedFullCheck();
  const { api } = io;
  io.api = async (path, body, method) => {
    const result = await api(path, body, method);
    if (path === "pulls/1/ready")
      state.checkRuns.push({
        ...run(12, "head", "queued", null),
        event: "pull_request",
        created_at: new Date(state.now).toISOString(),
      });
    return result;
  };
  let waits = 0;
  io.wait = async () => {
    assert.ok(state.writes.includes("pulls/1/ready"));
    assert.equal(++waits, 1);
    state.now += 10 * 60_000 + 1;
  };
  await assert.rejects(
    () => deliver("example/app", 1, io),
    (error) => error instanceof DeliveryRefusal && error.message === stalledReason && error.head === "head",
  );
  assert.deepEqual(
    state.writes.filter((path: string) => /\/(draft|ready)$/.test(path)),
    ["pulls/1/draft", "pulls/1/ready"],
  );
  assert.equal(state.merges, 0);
});

test("um check aceito há menos de dez minutos continua esperando sem reinicialização", async () => {
  for (const age of [20_000, 10 * 60_000]) {
    const { io, state, checkJobs } = queuedFullCheck("queued", age);
    let waits = 0;
    io.wait = async () => {
      assert.equal(++waits, 1);
      Object.assign(state.checkRuns[0], { status: "completed", conclusion: "success" });
      checkJobs.set(10, [passedJob]);
    };
    assert.equal((await deliver("example/app", 1, io)).merged, "merged");
    assert.equal(waits, 1);
    assert.ok(!state.writes.some((path: string) => /\/(draft|ready)$/.test(path)));
  }
});

test("um check antigo com um job na fila continua esperando uma máquina sem reinicialização", async () => {
  for (const name of ["check", "prepare"]) {
    const { io, state, checkJobs } = queuedFullCheck("queued", 15 * 60_000, [{ name, status: "queued" }]);
    let waits = 0;
    io.wait = async () => {
      assert.equal(++waits, 1);
      Object.assign(state.checkRuns[0], { status: "completed", conclusion: "success" });
      checkJobs.set(10, [passedJob]);
    };
    assert.equal((await deliver("example/app", 1, io)).merged, "merged");
    assert.equal(waits, 1);
    assert.ok(!state.writes.some((path: string) => /\/(draft|ready)$/.test(path)));
  }
});

test("a próxima rodada de entrega lembra a reinicialização só para o mesmo head", async () => {
  const { io, state } = queuedFullCheck();
  state.checkRuns[0].id = 12;
  io.checkRecovery = { head: "head", after: 11 };
  await assert.rejects(() => deliver("example/app", 1, io), { message: stalledReason });
  assert.ok(!state.writes.some((path: string) => /\/(draft|ready)$/.test(path)));
  const next = queuedFullCheck();
  next.io.checkRecovery = { head: "previous", after: 99 };
  await assert.rejects(() => deliver("example/app", 1, next.io), /still waiting/);
  assert.ok(next.state.writes.includes("pulls/1/draft"));
});

test("um job de matriz conta como o job exigido, cada perna dele", async () => {
  const done = { conclusion: "success", status: "completed" };
  const leg = (name: string, fields: object = done) => ({ name, ...fields });
  for (const [jobs, conclusion, want] of [
    [[leg("check (ubuntu-latest)"), leg("check (macos-latest)")], "success", "passed"],
    [[leg("check (ubuntu-latest)"), leg("check (macos-latest)", { status: "in_progress" })], null, "waiting"],
    [[leg("check (ubuntu-latest)"), leg("check (macos-latest)", { conclusion: "failure" })], "failure", "failed"],
    [[leg("check-lint"), leg("checkout")], "success", "waiting"],
  ] as const) {
    const { io } = fixture();
    const status = conclusion ? "completed" : "in_progress";
    io.api = async (p) =>
      p.includes("/jobs")
        ? { jobs }
        : { workflow_runs: [{ ...run(1, "head", status, conclusion), event: "pull_request" }] };
    assert.equal(await fullCheck("head", config, io), want);
  }
});
test("um workflow só de draft cancelado não reprova o novo check pronto", async () => {
  const { io } = fixture();
  io.api = async (p) =>
    p.includes("/jobs")
      ? { jobs: [{ name: "draft", conclusion: "cancelled" }] }
      : { workflow_runs: [{ ...run(1, "head", "completed", "cancelled"), event: "pull_request" }] };
  assert.equal(await fullCheck("head", config, io), "waiting");
});
test("check completo reprovado nunca atesta nem mescla, e o auto-merge é confirmado desativado", async () => {
  const { io, state } = fixture();
  state.pr.auto_merge = {};
  const api = io.api;
  io.api = async (...args) =>
    args[0].startsWith("actions/workflows/check")
      ? { workflow_runs: [{ ...run(1, "head", "completed", "failure"), event: "pull_request" }] }
      : api(...args);
  await assert.rejects(() => deliver("example/app", 1, io), /check/);
  assert.equal(state.pr.auto_merge, null);
  assert.equal(state.merges, 0);
  assert.ok(!state.statuses.some((s: any) => s.context === "my-review"));
});
test("o cancelamento do auto-merge relê requisições perdidas e recusa estado desconhecido", async () => {
  const { io, state } = fixture();
  state.pr.auto_merge = {};
  io.disableAuto = async () => {
    state.pr.auto_merge = null;
    throw new Error("lost");
  };
  await disableAuto(1, io);
  state.pr.auto_merge = {};
  io.disableAuto = async () => {};
  io.wait = async () => {};
  await assert.rejects(() => disableAuto(1, io), /merge automático/);
});
test("uma falha na releitura do auto-merge é repetida, mas nunca tratada como desativado", async () => {
  const { io } = fixture();
  let reads = 0;
  io.wait = async () => {};
  io.api = async () => {
    if (++reads === 1) throw new Error("HTTP 502");
    return { auto_merge: null };
  };
  await disableAuto(1, io);
  assert.equal(reads, 2);
  reads = 0;
  io.api = async () => {
    reads++;
    throw new Error("HTTP 502");
  };
  await assert.rejects(() => disableAuto(1, io), /não foi possível confirmar que o merge automático/);
  assert.equal(reads, 3);
});
test("o health em produção não pode esconder um Ship incompleto ou reprovado", async () => {
  for (const [status, conclusion] of [
    ["in_progress", null],
    ["completed", "failure"],
    ["completed", "cancelled"],
  ] as const) {
    const { io } = fixture();
    io.api = async () => ({ workflow_runs: [run(1, "merged", status, conclusion)] });
    await assert.rejects(() => waitLive("merged", config, io));
  }
});
test("entrega concluída ignora publicações na fila/reprovadas; a sucessora precisa estar em produção", async () => {
  for (const status of ["queued", "completed"]) {
    const { io } = fixture();
    io.contains = async (a, b) => a === b || (a === "merged" && b === "later");
    io.api = async () => ({ workflow_runs: [run(), run(2, "later", status, "failure")] });
    await waitLive("merged", config, io);
  }
  const { io } = fixture();
  io.contains = async (a, b) => a === b || (a === "merged" && b === "later");
  io.api = async () => ({ workflow_runs: [run(1, "merged", "completed", "cancelled"), run(2, "later")] });
  await assert.rejects(() => waitLive("merged", config, io), /waiting/);
  io.live = async () => ({ sha: "later", release: "later" });
  await waitLive("merged", config, io);
});
