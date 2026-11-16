// O arquivo de regras é o que o titular muda pedindo a um Agent, então um erro precisa ser pego, dizer qual regra e o que está
// errado, e deixar as regras antigas rodando. Casos de falha: uma regra nomeando uma fonte ou Agent que não existe; duas regras
// com o mesmo nome; uma regra que não casa com nenhum evento ou com uma fonte e um agendamento ao mesmo tempo; um agendamento
// malformado ou que nunca chega; um modo desconhecido de notificar; um Agent sem worker, com um nível de acesso desconhecido,
// com um programa a iniciar que não é um caminho só, com um tier de serviço que não é uma palavra, ou com um comando sem linha
// de comando; uma regra que manda o trabalho para um Agent ACP sem linha de comando, o que só aparece quando roda e então falha
// dez vezes, ou um Agent ACP assim que nenhuma regra usa e que nunca prejudicou ninguém sendo recusado; uma regra sem skill nem
// prompt, ou sem pasta; um campo escrito errado aceito em silêncio; uma regra rodando mais de uma por vez sem dizer quantas, ou
// regras de um grupo discordando nisso; um emits nomeando uma fonte que não existe; os channels de uma regra nomeando um que não
// existe, ou nenhum; defaultChannels nomeando um que não existe, ou nenhum; uma tarefa agendada mostrada na página nomeando uma
// fonte ou Agent que não existe ou um agendamento malformado, ou dizendo como as respostas dela continuam sem dizer onde (cwd),
// ou onde sem como; um fuso horário que não existe; um título de sessão com um espaço, que um cliente que pega a primeira palavra
// cortaria, com um placeholder que ele não conhece, que chegaria ao Agent como escrito, ou não começando com letra ou dígito, de
// modo que um objeto vindo de fora pode liderar o prompt e ser lido pela linha de comando do Agent como uma opção (-x) ou um
// comando (/x); a fonte reservada redefinida; uma regra nula quebra o reload em vez de manter as regras antigas; uma tarefa em
// outro lugar que não consegue dizer em qual modelo o aplicativo dela a roda, então um cliente que a exibe toma emprestado o do
// Agent, ou uma que diz isso com uma palavra vazia.
// Um arquivo bom mudando no disco passa a valer; um ruim não, e diz o porquê. Um arquivo que sumiu ou que não pode ser lido
// quebra a central, no reload ou na reinicialização, em vez de manter as regras que ela tinha. Um arquivo quebrado enquanto a
// central estava fora do ar nunca é avisado, porque nada nele muda depois que a inicialização o leu.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";

const home = setup("rules");
const { parseRules, RulesError, rules, ruleNamed, reloadRules, one } = await import("./hub.ts");
const { typeMatches } = await import("../kernel/rules.ts");

const good = () => JSON.parse(readFileSync(join(import.meta.dirname, "rules.fixture.json"), "utf8"));
const problem = (change: (r: any) => void, words: RegExp) => {
  const r = good();
  change(r);
  assert.throws(
    () => parseRules(JSON.stringify(r)),
    (error: Error) => {
      assert.ok(error instanceof RulesError);
      assert.match(error.message, words);
      return true;
    },
  );
};

test("uma tarefa em outro lugar pode dizer em qual modelo e esforço o aplicativo dela a roda", () => {
  const told = good();
  Object.assign(told.elsewhere[0], { model: "some-model", effort: "high" });
  const [task] = parseRules(JSON.stringify(told)).elsewhere;
  assert.deepEqual([task.model, task.effort], ["some-model", "high"]);
});

test("o fixture carrega, com os padrões preenchidos", () => {
  const r = parseRules(JSON.stringify(good()));
  assert.equal(r.rules[0].tell, "needed");
  assert.equal(r.rules[2].group, "alerta também registra", "o grupo de uma regra é por padrão o próprio nome dela");
  assert.ok(r.askFirst.includes("apagar dados"));
  assert.equal(r.sources.schedule.name, "agendamento");
  assert.equal(r.agents.a1.access, "edit", "o nível seguro a menos que o autor da regra peça outro");
  assert.equal(r.agents.a2.access, "full");
  const wrapped = good();
  wrapped.agents.a1.program = "/opt/bin/claude-via-gateway";
  assert.equal(parseRules(JSON.stringify(wrapped)).agents.a1.program, "/opt/bin/claude-via-gateway");
  wrapped.agents.a1.maxActive = 3;
  wrapped.rules[0].maxActive = 1;
  const limited = parseRules(JSON.stringify(wrapped));
  assert.equal(limited.agents.a1.maxActive, 3);
  assert.equal(limited.rules[0].maxActive, 1);
  assert.equal(r.rules[0].title, "note-{id}");
  assert.equal(r.rules[1].title, undefined, "nenhum título a menos que a regra dê um");
});

test("um erro diz qual regra e o que está errado", () => {
  problem((r) => {
    r.rules[0].to = "nobody";
  }, /a regra "opiniões".*to.*não é um Agent registrado: nobody/);
  problem((r) => {
    r.rules[0].channels = ["chat", "nowhere"];
  }, /a regra "opiniões".*channels.*nowhere/);
  problem((r) => {
    r.rules[0].channels = [];
  }, /a regra "opiniões".*channels/);
  problem((r) => {
    r.defaultChannels = ["nowhere"];
  }, /defaultChannels.*nowhere/);
  problem((r) => {
    r.defaultChannels = [];
  }, /defaultChannels/);
  problem((r) => {
    r.rules[0].when.source = "nowhere";
  }, /a regra "opiniões".*fonte.*nowhere/);
  problem((r) => {
    r.rules[1].name = "opiniões";
  }, /o nome de regra "opiniões" está duplicado/);
  problem((r) => {
    r.rules[0].when.types = [];
  }, /a regra "opiniões".*types/);
  problem((r) => {
    r.rules[0].when.cron = "0 9 * * *";
  }, /a regra "opiniões".*when/);
  problem((r) => {
    r.rules[3].when.cron = "99 * * * *";
  }, /a regra "briefing matinal".*cron/);
  problem((r) => {
    r.rules[3].when.cron = "0 0 30 2 *";
  }, /a regra "briefing matinal".*nunca chega/);
  problem((r) => {
    r.rules[0].tell = "sometimes";
  }, /a regra "opiniões".*tell/);
  problem((r) => {
    delete r.rules[0].cwd;
  }, /a regra "opiniões".*está sem cwd/);
  problem((r) => {
    r.rules[0].cwd = "relative/path";
  }, /a regra "opiniões".*cwd/);
  problem((r) => {
    delete r.rules[1].prompt;
  }, /a regra "alerta".*skill.*prompt/);
  problem((r) => {
    r.rules[0].oops = 1;
  }, /a regra "opiniões".*tem o campo desconhecido oops/);
  problem((r) => {
    delete r.rules[0].parallel;
    r.rules[1].group = "notes";
    r.rules[1].parallel = 2;
  }, /as regras do grupo "notes" precisam ter o mesmo parallel/);
  problem((r) => {
    r.rules[0].parallel = 0;
  }, /a regra "opiniões".*parallel/);
  problem((r) => {
    r.rules[0].maxActive = 0;
  }, /a regra "opiniões".*maxActive/);
  problem((r) => {
    r.agents.a1.maxActive = 1.5;
  }, /o Agent a1.*maxActive/);
  problem((r) => {
    r.rules[0].resume = "thread";
  }, /a regra "opiniões".*resume/);
  problem((r) => {
    r.rules[0].title = "";
  }, /a regra "opiniões".*title/);
  problem((r) => {
    r.rules[0].title = "note {id}";
  }, /a regra "opiniões".*title.*sem espaços/);
  problem((r) => {
    r.rules[0].title = "note-{ID}";
  }, /a regra "opiniões".*title.*\{id\} e \{subject\}/);
  for (const title of ["{id}-note", "-note", "/note", "note-{{id}}", "note-{id"]) {
    problem((r) => {
      r.rules[0].title = title;
    }, /a regra "opiniões".*title.*começando com letra ou número/);
  }
  problem((r) => {
    r.rules[4].emits.source = "nowhere";
  }, /a regra "inspeção".*emits/);
  problem((r) => {
    delete r.agents.a1.worker;
  }, /o Agent a1.*está sem worker/);
  problem((r) => {
    r.agents.a1.access = "root";
  }, /o Agent a1.*access/);
  problem((r) => {
    r.agents.a1.program = ["/opt/bin/claude"];
  }, /o Agent a1.*program/);
  problem((r) => {
    r.agents.a2.tier = "";
  }, /o Agent a2.*o campo tier/);
  problem((r) => {
    delete r.agents.a3.command;
  }, /o Agent a3.*command/);
  problem((r) => {
    r.agents.a1.oops = 1;
  }, /o Agent a1.*tem o campo desconhecido oops/);
  problem((r) => {
    r.sources.schedule = { name: "x" };
  }, /a fonte schedule é reservada/);
  problem((r) => {
    r.sources["Bad Id"] = { name: "x" };
  }, /o identificador da fonte/);
  problem((r) => {
    r.channels.chat.answerers = "me";
  }, /o canal chat.*answerers/);
  problem((r) => {
    r.elsewhere[0].to = "nobody";
  }, /a tarefa agendada "limpeza semanal".*to/);
  problem((r) => {
    r.elsewhere[0].source = "nowhere";
  }, /a tarefa agendada "limpeza semanal".*source/);
  problem((r) => {
    r.elsewhere[0].cron = "nope";
  }, /a tarefa agendada "limpeza semanal".*cron/);
  problem((r) => {
    r.elsewhere[0].name = "opiniões";
  }, /a tarefa agendada "opiniões" tem o mesmo nome/);
  problem((r) => {
    r.elsewhere[0].model = "";
  }, /a tarefa agendada "limpeza semanal".*model/);
  problem((r) => {
    r.elsewhere[0].effort = 3;
  }, /a tarefa agendada "limpeza semanal".*effort/);
  problem((r) => {
    r.elsewhere[0].skill = "weekly";
  }, /a tarefa agendada "limpeza semanal".*cwd/);
  problem((r) => {
    r.elsewhere[0].cwd = "code/app";
  }, /a tarefa agendada "limpeza semanal".*cwd/);
  problem((r) => {
    r.elsewhere[0].cwd = "~/code/app";
  }, /a tarefa agendada "limpeza semanal".*skill e prompt/);
  problem((r) => {
    r.timezone = "Mars/Olympus";
  }, /timezone/);
  problem((r) => {
    r.askFirst = "apagar dados";
  }, /askFirst/);
  assert.throws(() => parseRules("{ not json"), /não é JSON/);
});

test("tipos casam exatamente, por prefixo ou todos", () => {
  assert.ok(typeMatches(["feedback.*"], "feedback.new"));
  assert.ok(!typeMatches(["feedback.*"], "feedbackx.new"));
  assert.ok(typeMatches(["alert.raised"], "alert.raised"));
  assert.ok(!typeMatches(["alert.raised"], "alert.raised.more"));
  assert.ok(typeMatches(["*"], "anything"));
});

test("uma regra nula é um erro de regras e deixa a configuração em execução intacta", () => {
  problem((r) => {
    r.rules = [null];
  }, /deve ser um objeto/);
  const file = join(home, "null-rules.json");
  const broken = good();
  broken.rules = [null];
  writeFileSync(file, JSON.stringify(broken));
  assert.match(reloadRules(file).problem!, /objeto/);
  assert.equal(ruleNamed("opiniões")!.to, "a1");
});

test("o que foi carregado pode ser lido de volta", () => {
  assert.equal(ruleNamed("briefing matinal")!.to, "a1");
  assert.equal(ruleNamed("não existe"), undefined);
  assert.equal(rules.timezone, "Asia/Shanghai");
});

test("um arquivo bom mudando no disco passa a valer; um ruim deixa as regras antigas e diz o porquê", () => {
  const file = join(home, "rules.json");
  process.env.AGENT_AUTOLOOP_RULES = file;
  const changed = good();
  changed.rules[0].prompt = "Novo enunciado.";
  writeFileSync(file, JSON.stringify(changed));
  assert.equal(reloadRules(file).problem, undefined);
  assert.equal(ruleNamed("opiniões")!.prompt, "Novo enunciado.");
  const facts = () => one<{ count: number }>("SELECT COUNT(*) AS count FROM facts")!.count;
  const before = facts();
  assert.equal(reloadRules(file).problem, undefined);
  assert.equal(facts(), before, "nada de novo no disco, então nada entra no registro");
  const broken = good();
  broken.rules[0].to = "nobody";
  writeFileSync(file, JSON.stringify(broken));
  assert.match(reloadRules(file).problem!, /nobody/);
  assert.equal(ruleNamed("opiniões")!.prompt, "Novo enunciado.", "as regras antigas continuam rodando");
});

test("um arquivo de regras que não pode ser lido é um problema, não uma quebra, e as regras antigas continuam rodando", () => {
  assert.match(reloadRules(join(home, "gone.json")).problem!, /não encontrei/);
  assert.equal(ruleNamed("opiniões")!.prompt, "Novo enunciado.");
  assert.match(reloadRules(home).problem!, /não foi possível ler/, "uma pasta onde o arquivo deveria estar");
});

test("um arquivo de regras quebrado enquanto a central estava fora do ar é avisado no primeiro tick, a menos que seja corrigido até lá", () => {
  const down = join(home, "down");
  mkdirSync(down);
  const file = join(down, "rules.json");
  const start = (afterStarting = "") => {
    const started = spawnSync(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "--input-type=module",
        "-e",
        `const hub = await import(${JSON.stringify(new URL("../host/runtime.ts", import.meta.url).href)});` +
          `const { rows } = await import(${JSON.stringify(new URL("../kernel/evolve.ts", import.meta.url).href)});` +
          `${afterStarting}; hub.tick();` +
          `console.log(JSON.stringify(rows(hub.getView(), "cards", { state: "open" }).map((card) => card.title)))`,
      ],
      { env: { ...process.env, AGENT_AUTOLOOP_HOME: down, AGENT_AUTOLOOP_RULES: file }, encoding: "utf8" },
    );
    assert.equal(started.status, 0, started.stderr);
    return JSON.parse(started.stdout);
  };
  writeFileSync(file, JSON.stringify(good()));
  assert.deepEqual(start(), []);
  const broken = good();
  broken.rules[0].to = "nobody";
  writeFileSync(file, JSON.stringify(broken));
  assert.deepEqual(start(), ["o rules.json está com erro; as regras antigas continuam em uso"]);
  const fix = `(await import("node:fs")).writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(JSON.stringify(good()))})`;
  assert.deepEqual(start(fix), [], "corrigido até lá, e o cartão de antes também sumiu");
});

test("uma central que reinicia sem o arquivo de regras sobe com as regras que tinha; uma nova sem nenhuma diz o porquê", () => {
  const start = (env: Record<string, string>) =>
    spawnSync(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "--input-type=module",
        "-e",
        `const hub = await import(${JSON.stringify(new URL("./hub.ts", import.meta.url).href)});` +
          `console.log(hub.ruleNamed("opiniões")?.prompt)`,
      ],
      { env: { ...process.env, ...env }, encoding: "utf8" },
    );
  const restarted = start({ AGENT_AUTOLOOP_RULES: join(home, "gone.json") });
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.equal(restarted.stdout.trim(), "Novo enunciado.", "as regras que ela carregou por último, não as do fixture");
  const fresh = start({ AGENT_AUTOLOOP_HOME: join(home, "fresh"), AGENT_AUTOLOOP_RULES: join(home, "gone.json") });
  assert.notEqual(fresh.status, 0);
  assert.match(fresh.stderr, /não encontrei/);
});
