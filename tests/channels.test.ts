// Os canais que já vêm prontos e o adaptador de webhook. Nenhum listener real roda aqui: só um pode deter os cliques
// nos cartões de um aplicativo. Casos de falha: um primeiro envio usa uma chave que muda com a versão, ou uma
// atualização envia uma mensagem nova; um envio que falhou não é reportado; um clique que não é de um cartão é aceito;
// as opções de um cartão não aparecem enquanto ele está aberto, ou continuam aparecendo depois; o listener que morre
// não é iniciado de novo, ou um listener que não consegue iniciar derruba a central inteira. Um webhook do GitHub com
// assinatura errada, ou sem assinatura, é aceito; o que não é identificador chega ao subject; um ping gera um evento;
// tokens de substituição no texto do cartão reescrevem um modelo de webhook. Um cartão já resolvido que o Feishu não
// deixa o bot alterar fica na versão anterior à resposta; um aberto é enviado de novo com botões que não contam.
// Uma chamada de CLI lenta não pode bloquear o loop HTTP da central ao consultar um usuário, enviar ou atualizar cartão.
// Um cartão de pergunta que só aceita escolhas perde a conta que alguém digitaria; texto sem escolha ainda responde.
// Um U+2028 ou U+2029 no que alguém digitou, que o JSON deixa como está, corta a linha do clique e perde o clique.
// Versões mais antigas do lark-cli rejeitam `--content -`, então um primeiro cartão não pode depender dessa convenção.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import feishu, { render } from "../plugins/feishu/channel.ts";
import webhook from "../plugins/webhook/channel.ts";
import github from "../plugins/github/source.ts";
import type { Card } from "../host/channels.ts";

const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-channels-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const base: Card = {
  id: 5,
  version: 1,
  ref: null,
  kind: "ask",
  state: "open",
  title: "Apagar ou não",
  text: "Ocupa 10 GB",
  options: ["Apagar", "Manter"],
  recommend: 1,
  choice: null,
  answer: null,
  result: null,
  link: "https://hub.test/c/x",
};

test("um cartão diz de que regra ou tarefa veio, em qualquer estado, a menos que o título já diga", () => {
  const from = (card: Card) => (render(card).header as any).subtitle?.content;
  assert.equal(from({ ...base, rule: "inspeção diária do site aberto" }), "Fonte: inspeção diária do site aberto");
  assert.equal(
    from({ ...base, rule: "inspeção diária do site aberto", state: "done", choice: 0, result: "apagado" }),
    "Fonte: inspeção diária do site aberto",
  );
  assert.equal(from(base), undefined, "os cartões da própria central não nomeiam regra");
  assert.equal(from({ ...base, kind: "notice", rule: "alerta AIHOT", title: "alerta AIHOT" }), undefined);
});

test("um cartão mostra suas opções enquanto aberto, e o que foi feito dele depois", () => {
  const open = render(base);
  const blocks = open.body.elements.filter((e) => e.tag === "interactive_container") as any[];
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[1].behaviors[0].value, { card: 5, choice: 1 });
  assert.equal(blocks[1].border_color, "blue", "o recomendado se destaca");
  const said = (card: Card) => JSON.stringify(render(card).body.elements);
  assert.match(said({ ...base, state: "decided", choice: 1 }), /Você escolheu Manter\. Registrado/);
  assert.ok(!said({ ...base, state: "decided", choice: 1 }).includes("callback"));
  assert.match(
    said({ ...base, state: "done", choice: 0, result: "apagado" }),
    /Você escolheu Apagar\. Executado: apagado/,
  );
  assert.match(said({ ...base, state: "decided", answer: "arquivar" }), /Você escolheu arquivar/);
  assert.match(
    said({ ...base, state: "closed", result: "o problema se resolveu sozinho" }),
    /Não precisa mais decidir: o problema se resolveu sozinho/,
  );
  assert.match(said({ ...base, kind: "notice", state: "closed", options: [], result: "Resolvido" }), /Resolvido/);
  const noticeOpen = JSON.stringify(render({ ...base, kind: "notice", options: [] }).body.elements);
  assert.ok(noticeOpen.includes('"tag":"form"'), "uma notificação pode receber uma linha escrita por você");
  assert.ok(noticeOpen.includes("handling_note_submit_5"), "o botão de envio carrega o número do cartão");
  assert.ok(noticeOpen.includes('"name":"note"'), "o campo do formulário tem nome, então o texto dele volta");
  assert.ok(
    noticeOpen.includes('"form_action_type":"submit"'),
    "é assim que um cartão Feishu 2.0 marca o botão de envio de um formulário",
  );
  const askOpen = JSON.stringify(render(base).body.elements);
  assert.ok(askOpen.includes("ask_text_submit_5"), "um cartão de pergunta também recebe texto, não só uma escolha");
  assert.ok(askOpen.includes('"name":"note"'), "o campo do formulário da pergunta tem nome, então o texto volta");
  assert.ok(
    !said({ ...base, state: "decided", choice: 1 }).includes('"tag":"form"'),
    "um cartão de pergunta já resolvido não deixa formulário para enviar",
  );
  assert.match(
    said({ ...base, kind: "notice", state: "closed", options: [], result: "Resolvido", answer: "limpei 3GB" }),
    /Nota de tratamento: limpei 3GB/,
  );
  assert.ok(
    !said({ ...base, kind: "notice", state: "closed", options: [], result: "Resolvido" }).includes(
      "Nota de tratamento",
    ),
  );
});

test("as chamadas de CLI do feishu deixam o loop HTTP disponível", async () => {
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const lark = join(dir, "async-lark");
  writeFileSync(
    lark,
    `#!${process.execPath}
if (process.argv[2] === 'event') { setInterval(() => {}, 1000); }
else {
  (async () => {
    if (process.argv[2] !== 'auth') for await (const chunk of process.stdin) {}
    await fetch(${JSON.stringify(url)}, { signal: AbortSignal.timeout(2000) });
    console.log(JSON.stringify({ ok: true, identities: { user: { openId: 'ou_me' } }, data: { message_id: 'om_5' } }));
  })().catch(() => process.exit(1));
}
`,
    { mode: 0o755 },
  );
  const stop = new AbortController();
  const cards = [base, { ...base, version: 2, ref: "om_5" }];
  let delivered = 0;
  const failed: unknown[] = [];
  const hub = {
    async nextCard() {
      const card = cards.shift() ?? null;
      if (!card) stop.abort();
      return { card };
    },
    async delivered() {
      delivered++;
    },
    async failed(...args: unknown[]) {
      failed.push(args);
    },
  };
  try {
    await feishu({ hub: hub as any, options: { lark }, log: () => {}, signal: stop.signal });
    assert.deepEqual(failed, []);
    assert.equal(delivered, 2);
    assert.equal(requests, 3, "consulta de usuário, envio e patch deixaram o HTTP responder, cada um por si");
  } finally {
    stop.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("feishu: um lark-cli que não consegue iniciar é avisado, não deixado derrubar a central", async () => {
  const stop = new AbortController();
  const lines: string[] = [];
  const hub = { nextCard: () => new Promise((resolve) => setTimeout(() => resolve({ card: null }), 5)) };
  const log = (line: string) => {
    lines.push(line);
    stop.abort();
  };
  // Retornar mostra que o loop do listener seguiu além da falha, até onde iniciaria de novo. Sem o limite de tempo,
  // uma exceção, que o executor de testes captura, deixaria isto esperando para sempre.
  const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(5_000)]);
  await feishu({ hub: hub as any, options: { user: "ou_me", lark: join(dir, "not-there") }, log, signal });
  assert.match(lines[0] ?? "", /ENOENT/);
});

test("feishu: um primeiro cartão funciona sem a convenção de conteúdo por stdin do lark-cli", async () => {
  const lark = join(dir, "lark-cli-no-stdin-content");
  writeFileSync(
    lark,
    `#!/bin/sh
case "$*" in
  *"event consume"*) exec sleep 30 ;;
  *"+messages-send"*)
    previous=
    content=
    for argument do
      if [ "$previous" = "--content" ]; then content=$argument; break; fi
      previous=$argument
    done
    case "$content" in
      \{*) echo '{"ok":true,"data":{"message_id":"om_5"}}' ;;
      *) exit 1 ;;
    esac ;;
esac
`,
    { mode: 0o755 },
  );
  const stop = new AbortController();
  const cards: (Card | null)[] = [base];
  const delivered: unknown[][] = [];
  const failed: unknown[][] = [];
  const hub = {
    async nextCard() {
      if (cards.length) return { card: cards.shift()! };
      stop.abort();
      return { card: null };
    },
    async delivered(...args: unknown[]) {
      delivered.push(args);
      return {};
    },
    async failed(...args: unknown[]) {
      failed.push(args);
      return {};
    },
  };
  await feishu({ hub: hub as any, options: { user: "ou_me", lark }, log: () => {}, signal: stop.signal });
  assert.deepEqual(failed, []);
  assert.deepEqual(delivered, [[5, 1, "om_5"]]);
});

test("feishu: envia uma vez por cartão, atualiza no lugar, reporta falha e só cliques reais contam", async () => {
  const log = join(dir, "lark.log");
  const lark = join(dir, "lark-cli");
  // Um substituto do lark-cli: anota cada chamada; `event consume` imprime dois cliques e espera ser parado.
  writeFileSync(
    lark,
    `#!/bin/sh
echo "$*" >> "${log}"
case "$*" in
  *"event consume"*)
    echo '{"action_value":"{\\"card\\":5,\\"choice\\":1}","operator_id":"ou_me","message_id":"om_5"}'
    echo '{"action_value":"{\\"other\\":1}","operator_id":"ou_me","message_id":"om_5"}'
    exec sleep 30 ;;
  *fail-me*) exit 1 ;;
  *) cat > /dev/null; echo '{"ok":true,"data":{"message_id":"om_5"}}' ;;
esac
`,
  );
  chmodSync(lark, 0o755);
  const stop = new AbortController();
  const cards: (Card | null)[] = [
    base,
    { ...base, version: 2, ref: "om_5", state: "decided", choice: 1 },
    { ...base, id: 6, title: "fail-me", ref: null },
  ];
  const calls: unknown[][] = [];
  const hub = {
    async nextCard() {
      if (cards.length) return { card: cards.shift()! };
      await new Promise((resolve) => setTimeout(resolve, 150));
      stop.abort();
      return { card: null };
    },
    async delivered(...args: unknown[]) {
      calls.push(["delivered", ...args]);
      return {};
    },
    async failed(...args: unknown[]) {
      calls.push(["failed", args[0], args[1]]);
      return {};
    },
    async answer(...args: unknown[]) {
      calls.push(["answer", ...args]);
      return { changed: true };
    },
  };
  // Um cartão que não pode ser enviado: o texto dentro dele manda o lark-cli falhar.
  writeFileSync(
    lark,
    readFileSync(lark, "utf8").replace(
      "*fail-me*) exit 1 ;;",
      '*+messages-send*) case "$*" in *fail-me*) exit 1 ;; esac; echo \'{"ok":true,"data":{"message_id":"om_5"}}\' ;;',
    ),
  );
  await feishu({ hub: hub as any, options: { user: "ou_me", lark }, log: () => {}, signal: stop.signal });
  const lines = readFileSync(log, "utf8").trim().split("\n");
  const sends = lines.filter((l) => l.includes("+messages-send"));
  assert.ok(sends[0].includes("--idempotency-key agent-autoloop-card-5"), "a chave não muda com a versão");
  assert.ok(sends[0].includes("--user-id ou_me"));
  assert.ok(
    lines.some((l) => l.includes("messages patch --message-id om_5")),
    "uma atualização altera a mensagem que foi enviada",
  );
  assert.deepEqual(
    calls.find((c) => c[0] === "delivered" && c[2] === 1),
    ["delivered", 5, 1, "om_5"],
  );
  assert.deepEqual(
    calls.find((c) => c[0] === "delivered" && c[2] === 2),
    ["delivered", 5, 2, "om_5"],
  );
  assert.deepEqual(
    calls.find((c) => c[0] === "failed"),
    ["failed", 6, 1],
  );
  assert.deepEqual(
    calls.filter((c) => c[0] === "answer"),
    [["answer", 5, { choice: 1, by: "ou_me", ref: "om_5" }]],
  );
});

test("feishu: U+2028 e U+2029 numa nota de tratamento não perdem o clique", async () => {
  const lark = join(dir, "lark-cli-separators");
  writeFileSync(
    lark,
    `#!/bin/sh
case "$*" in
  *"event consume"*)
    echo '{"action_name":"handling_note_submit_8","action_value":"","form_value":"{\\"note\\":\\"primeira linha segunda linha terceira linha\\"}","operator_id":"ou_me","message_id":"om_8"}'
    exec sleep 30 ;;
  *) cat > /dev/null; echo '{"ok":true,"data":{"message_id":"om_8"}}' ;;
esac
`,
  );
  chmodSync(lark, 0o755);
  const stop = new AbortController();
  const answers: unknown[][] = [];
  let answered = () => {};
  const click = new Promise<void>((resolve) => (answered = resolve));
  const hub = {
    async nextCard() {
      // Até o clique chegar, por mais ocupada que esta máquina esteja, ou até ficar claro que ele não vem.
      await Promise.race([click, new Promise((resolve) => setTimeout(resolve, 2_000))]);
      stop.abort();
      return { card: null };
    },
    async answer(...args: unknown[]) {
      answers.push(args);
      answered();
      return { changed: true };
    },
  };
  await feishu({ hub: hub as any, options: { user: "ou_me", lark }, log: () => {}, signal: stop.signal });
  assert.deepEqual(answers, [
    [8, { choice: 0, by: "ou_me", ref: "om_8", text: "primeira linha segunda linha terceira linha" }],
  ]);
});

test("feishu: o envio de um formulário leva a nota de tratamento, e o nome do botão acha o cartão", async () => {
  const log = join(dir, "lark-note.log");
  const lark = join(dir, "lark-cli-note");
  // O envio de um formulário tem action_value vazio: o número do cartão está no nome do botão, a nota no form_value.
  writeFileSync(
    lark,
    `#!/bin/sh
echo "$*" >> "${log}"
case "$*" in
  *"event consume"*)
    echo '{"action_name":"handling_note_submit_7","action_tag":"button","action_value":"","form_value":"{\\"note\\":\\"respondi a ele, o vídeo sai na semana que vem\\"}","operator_id":"ou_me","message_id":"om_7"}'
    echo '{"action_name":"handling_note_submit_7","action_value":"{\\"card\\":7,\\"choice\\":0}","operator_id":"ou_me","message_id":"om_7"}'
    exec sleep 30 ;;
  *) cat > /dev/null; echo '{"ok":true,"data":{"message_id":"om_7"}}' ;;
esac
`,
  );
  chmodSync(lark, 0o755);
  const stop = new AbortController();
  const cards: (Card | null)[] = [{ ...base, id: 7, kind: "notice", options: [], ref: "om_7" }];
  const calls: unknown[][] = [];
  const hub = {
    async nextCard() {
      if (cards.length) return { card: cards.shift()! };
      await new Promise((resolve) => setTimeout(resolve, 150));
      stop.abort();
      return { card: null };
    },
    async delivered() {
      return {};
    },
    async failed() {
      return {};
    },
    async answer(...args: unknown[]) {
      calls.push(["answer", ...args]);
      return { changed: true };
    },
  };
  await feishu({ hub: hub as any, options: { user: "ou_me", lark }, log: () => {}, signal: stop.signal });
  assert.deepEqual(
    calls.filter((c) => c[0] === "answer"),
    [
      ["answer", 7, { choice: 0, by: "ou_me", ref: "om_7", text: "respondi a ele, o vídeo sai na semana que vem" }],
      ["answer", 7, { choice: 0, by: "ou_me", ref: "om_7" }],
    ],
    "uma nota enviada e um clique simples contam os dois, o clique sem texto vazio",
  );
});

test("feishu: o formulário de texto de um cartão de pergunta responde com o texto e sem escolha", async () => {
  const log = join(dir, "lark-free.log");
  const lark = join(dir, "lark-cli-free");
  // Um envio de texto livre não tem escolha: o texto é a resposta, e um vazio não responde nada.
  writeFileSync(
    lark,
    `#!/bin/sh
echo "$*" >> "${log}"
case "$*" in
  *"event consume"*)
    echo '{"action_name":"ask_text_submit_7","action_tag":"button","action_value":"","form_value":"{\\"note\\":\\"conta test-ops senha s3cret\\"}","operator_id":"ou_me","message_id":"om_7"}'
    echo '{"action_name":"ask_text_submit_7","action_tag":"button","action_value":"","form_value":"{\\"note\\":\\"   \\"}","operator_id":"ou_me","message_id":"om_7"}'
    exec sleep 30 ;;
  *) cat > /dev/null; echo '{"ok":true,"data":{"message_id":"om_7"}}' ;;
esac
`,
  );
  chmodSync(lark, 0o755);
  const stop = new AbortController();
  const cards: (Card | null)[] = [{ ...base, id: 7, ref: "om_7" }];
  const calls: unknown[][] = [];
  const hub = {
    async nextCard() {
      if (cards.length) return { card: cards.shift()! };
      await new Promise((resolve) => setTimeout(resolve, 150));
      stop.abort();
      return { card: null };
    },
    async delivered() {
      return {};
    },
    async failed() {
      return {};
    },
    async answer(...args: unknown[]) {
      calls.push(["answer", ...args]);
      return { changed: true };
    },
  };
  await feishu({ hub: hub as any, options: { user: "ou_me", lark }, log: () => {}, signal: stop.signal });
  assert.deepEqual(
    calls.filter((c) => c[0] === "answer"),
    [["answer", 7, { by: "ou_me", ref: "om_7", text: "conta test-ops senha s3cret" }]],
    "o texto conta sem escolha, e um envio vazio não responde",
  );
});

test("um canal webhook posta o texto e o link uma vez, e não tem nada a fazer numa atualização", async () => {
  const seen: any[] = [];
  const target = createServer((req, res) => {
    let text = "";
    req.on("data", (c) => {
      text += c;
    });
    req.on("end", () => {
      seen.push(JSON.parse(text));
      res.statusCode = seen.length === 2 ? 500 : 200;
      res.end();
    });
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const stop = new AbortController();
  const literal = '$& $` $\' {text} "},"admin":true';
  const cards: Card[] = [
    { ...base, text: literal },
    { ...base, version: 2, ref: "sent-5", state: "decided", choice: 0 },
    { ...base, id: 7 },
  ];
  const calls: unknown[][] = [];
  const hub = {
    async nextCard() {
      if (cards.length) return { card: cards.shift()! };
      stop.abort();
      return { card: null };
    },
    async delivered(...args: unknown[]) {
      calls.push(["delivered", ...args]);
      return {};
    },
    async failed(...args: unknown[]) {
      calls.push(["failed", args[0], args[1]]);
      return {};
    },
    async answer() {
      return {};
    },
  };
  await webhook({
    hub: hub as any,
    options: {
      url: `http://127.0.0.1:${(target.address() as AddressInfo).port}`,
      body: { msgtype: "text", text: { content: "{text}" } },
    },
    log: () => {},
    signal: stop.signal,
  });
  target.close();
  assert.equal(seen.length, 2);
  assert.equal(seen[0].text.content, `${base.title}\n\n${literal}\n\n1. Apagar\n2. Manter\n\n${base.link}`);
  assert.match(seen[0].text.content, /Apagar ou não[\s\S]*1\. Apagar[\s\S]*https:\/\/hub\.test\/c\/x/);
  assert.deepEqual(calls, [
    ["delivered", 5, 1, "sent-5"],
    ["delivered", 5, 2, "sent-5"],
    ["failed", 7, 1],
  ]);
});

test("GitHub: com assinatura errada ou sem ela é recusado, e o que ele diz vira um evento simples", () => {
  const secret = "s3cret";
  const body = JSON.stringify({
    action: "opened",
    issue: { number: 12, title: "a home não abre", body: "detalhes", html_url: "https://github.com/a/b/issues/12" },
    repository: { full_name: "a/b", html_url: "https://github.com/a/b" },
  });
  const headers = (b: string, over: object = {}) => ({
    "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(b).digest("hex")}`,
    "x-github-event": "issues",
    "x-github-delivery": "d-1",
    ...over,
  });
  assert.deepEqual(github({ headers: headers(body), body, secret }), [
    {
      id: "d-1",
      type: "issues.opened",
      subject: "a/b#12",
      summary: "a home não abre",
      detail: "detalhes",
      link: "https://github.com/a/b/issues/12",
    },
  ]);
  assert.throws(() => github({ headers: headers(body, { "x-hub-signature-256": "sha256=00" }), body, secret }));
  assert.throws(() => github({ headers: { "x-github-event": "issues" }, body, secret }));
  assert.throws(() => github({ headers: headers(body), body, secret: "" }), "sem segredo configurado, nada é aceito");
  assert.deepEqual(github({ headers: headers("{}", { "x-github-event": "ping" }), body: "{}", secret }), []);
  const odd = JSON.stringify({ repository: { full_name: "a/b c" } });
  assert.match(
    (github({ headers: headers(odd, { "x-github-event": "push" }), body: odd, secret }) as any)[0].subject,
    /^a\/b-c$/,
  );
});

/** Um canal Feishu que recebe estes cartões, com um lark-cli que recusa toda atualização: o que rodou e o que reportou. */
async function refusedUpdates(given: Card[]) {
  const log = join(dir, "lark-patch.log");
  const lark = join(dir, "lark-patch");
  rmSync(log, { force: true });
  writeFileSync(
    lark,
    `#!/bin/sh
echo "$*" >> "${log}"
case "$*" in
  *"event consume"*) exec sleep 30 ;;
  *"messages patch"*) cat > /dev/null; exit 1 ;;
  *) cat > /dev/null; echo '{"ok":true,"data":{"message_id":"om_new"}}' ;;
esac
`,
  );
  chmodSync(lark, 0o755);
  const stop = new AbortController();
  const cards: Card[] = [...given];
  const calls: unknown[][] = [];
  const hub = {
    async nextCard() {
      if (cards.length) return { card: cards.shift()! };
      stop.abort();
      return { card: null };
    },
    async delivered(...args: unknown[]) {
      calls.push(["delivered", ...args]);
      return {};
    },
    async failed(id: number, version: number) {
      calls.push(["failed", id, version]);
      return {};
    },
    async answer(...args: unknown[]) {
      calls.push(["answer", ...args]);
      return { changed: true };
    },
  };
  await feishu({ hub: hub as any, options: { user: "ou_me", lark }, log: () => {}, signal: stop.signal });
  return { lines: readFileSync(log, "utf8").trim().split("\n"), calls };
}

test("feishu: um cartão já resolvido que não pode ser atualizado é enviado de novo, uma vez por versão", async () => {
  // Falha que isto evita: o bot não enviou a mensagem que está sendo atualizada, então o Feishu recusa e a atualização
  // é descartada quando as tentativas acabam. Quem lê fica então preso na versão anterior à resposta.
  const { lines, calls } = await refusedUpdates([{ ...base, version: 2, ref: "om_old", state: "decided", choice: 1 }]);
  assert.ok(
    lines.some((l) => l.includes("messages patch --message-id om_old")),
    "a mensagem que foi enviada é tentada primeiro",
  );
  const sends = lines.filter((l) => l.includes("+messages-send"));
  assert.equal(sends.length, 1, "uma atualização recusada cai para uma mensagem nova");
  assert.ok(sends[0].includes("--idempotency-key agent-autoloop-card-5-v2 "), "a segunda mensagem é desta versão");
  assert.deepEqual(calls, [["delivered", 5, 2, "om_old"]], "a central segue com a mensagem de que ouviu primeiro");
});

test("feishu: cartão aberto que não pode ser atualizado não é reenviado, e a 1ª chave é só o cartão", async () => {
  // Falha que isto evita: a central só conta respostas na primeira mensagem, então botões numa segunda não fariam
  // nada; uma primeira mensagem com a versão na chave chega duas vezes quando um relatório se perde e o cartão seguiu.
  const open = await refusedUpdates([{ ...base, version: 2, ref: "om_old" }]);
  assert.equal(open.lines.filter((l) => l.includes("+messages-send")).length, 0);
  assert.deepEqual(open.calls, [["failed", 5, 2]], "nova tentativa mais tarde");

  const first = await refusedUpdates([{ ...base, version: 3, ref: null }]);
  const [send] = first.lines.filter((l) => l.includes("+messages-send"));
  assert.ok(send.includes("--idempotency-key agent-autoloop-card-5 "), send);
  assert.deepEqual(first.calls, [["delivered", 5, 3, "om_new"]]);
});
