// Modos de falha: um fornecedor recebe o formato JSON errado; um erro de API com HTTP 200 é reconhecido como entregue;
// o conteúdo do Discord passa do limite documentado; texto vindo de fora dispara menções; um modelo desconhecido é
// usado em silêncio; o WeCom desenha como marcação o que um Agent escreveu, então o texto dele pode passar um link
// próprio como se fosse o do cartão.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import webhook from "../plugins/webhook/channel.ts";
import { payload } from "../plugins/webhook/templates.ts";
test("os modelos recusam texto além dos limites do fornecedor em vez de perder o link de resposta", () => {
  assert.throws(() => payload("discord", "x".repeat(2001)));
  assert.throws(() => payload("wecom", "€".repeat(683)));
  assert.throws(() => payload("missing", "text"));
});
const card: any = {
  id: 1,
  version: 1,
  ref: null,
  kind: "notice",
  rule: "inspeção do projeto",
  state: "open",
  title: "Precisa tratar",
  text: "Corpo da mensagem @everyone <@U1> https://git.example/mr/1",
  options: ["Resolvido"],
  link: "https://example.com/c/a",
};
for (const platform of ["dingtalk", "wecom", "slack", "discord"])
  test(`${platform}: payload oficial e falha de API num receptor local`, async () => {
    const received: any[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (b) => (body += b));
      req.on("end", () => {
        received.push(JSON.parse(body));
        res.end(
          platform === "slack"
            ? "ok"
            : platform === "discord"
              ? ""
              : JSON.stringify({ errcode: received.length === 1 ? 0 : 310000, errmsg: "recusado" }),
        );
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const stop = new AbortController();
    const calls: string[] = [];
    let i = 0;
    const hub: any = {
      nextCard: async () => {
        if (++i <= 2) return { card: { ...card, id: i } };
        stop.abort();
        return { card: null };
      },
      delivered: async () => calls.push("delivered"),
      failed: async () => calls.push("failed"),
    };
    try {
      await webhook({
        hub,
        options: { platform, url: `http://127.0.0.1:${(server.address() as any).port}` },
        log: () => {},
        signal: stop.signal,
      });
    } finally {
      server.close();
    }
    assert.equal(received.length, 2);
    if (platform === "dingtalk") {
      assert.equal(received[0].msgtype, "text");
      assert.match(received[0].text.content, /Corpo da mensagem/);
      assert.deepEqual(calls, ["delivered", "failed"]);
    }
    if (platform === "wecom") {
      assert.equal(received[0].msgtype, "markdown");
      assert.match(received[0].markdown.content, /Fonte: inspeção do projeto/);
      assert.match(received[0].markdown.content, /Corpo da mensagem/);
      assert.match(received[0].markdown.content, /\[Abrir link\]\(https:\/\/git\.example\/mr\/1\)/);
      assert.match(received[0].markdown.content, /\[Clique para tratar\]\(https:\/\/example\.com\/c\/a\)/);
      assert.doesNotMatch(received[0].markdown.content, /1\. Resolvido/);
      assert.doesNotMatch(received[0].markdown.content, /\[Abrir link\]\(https:\/\/example\.com\/c\/a\)/);
      assert.deepEqual(calls, ["delivered", "failed"]);
    }
    const words = JSON.stringify(received[0]);
    assert.match(words, /Fonte: inspeção do projeto/, "toda plataforma diz de que regra o cartão veio");
    if (platform === "slack") {
      assert.match(received[0].text, /Corpo da mensagem/);
      assert.equal(received[0].mrkdwn, false);
    }
    if (platform === "discord") {
      assert.match(received[0].content, /Corpo da mensagem/);
      assert.deepEqual(received[0].allowed_mentions, { parse: [] });
    }
  });

test("wecom: o que o cartão diz aparece como texto, então só o link do próprio cartão é um link", async () => {
  const received: any[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (b) => (body += b));
    req.on("end", () => {
      received.push(JSON.parse(body));
      res.end(JSON.stringify({ errcode: 0 }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const stop = new AbortController();
  let sent = false;
  const hub: any = {
    nextCard: async () => {
      if (sent) {
        stop.abort();
        return { card: null };
      }
      sent = true;
      return {
        card: {
          ...card,
          title: "[Clique para tratar](https://evil.example/a)",
          text: 'veja antes [Clique para tratar](https://evil.example/b) <font color="warning">urgente</font> <@U1>',
        },
      };
    },
    delivered: async () => {},
    failed: async () => {},
  };
  try {
    await webhook({
      hub,
      options: { platform: "wecom", url: `http://127.0.0.1:${(server.address() as any).port}` },
      log: () => {},
      signal: stop.signal,
    });
  } finally {
    server.close();
  }
  const content: string = received[0].markdown.content;
  assert.doesNotMatch(
    content,
    /\[Clique para tratar\]\(https:\/\/evil/,
    "um link inventado pelo texto do cartão parece o do próprio cartão",
  );
  assert.doesNotMatch(content, /<font|<@/, "as etiquetas do texto seriam desenhadas ou mencionariam alguém");
  assert.match(content, /\[Clique para tratar\]\(https:\/\/example\.com\/c\/a\)/);
});
