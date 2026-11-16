// Modos de falha: um corpo declarado grande demais é lido mesmo assim, então uma requisição que ninguém verificou ainda
// segura uma conexão à toa; um cliente que recebeu uma negativa é deixado numa conexão que ainda espera o resto do corpo
// dele, o que quebra a próxima requisição.
import assert from "node:assert/strict";
import { once } from "node:events";
import { connect, type AddressInfo } from "node:net";
import { after, test } from "node:test";
import { setup } from "./helpers.ts";

setup("body-limit");
const hub = await import("./hub.ts");
const { makeHandler } = await import("../host/server.ts");
const { serve } = await import("../host/http.ts");
const runtime = makeHandler();
after(runtime.close);
const key = hub.addKey("source", "app");
const MB = 1024 * 1024;

test("um corpo declarado grande demais não é lido de jeito nenhum", async () => {
  let read = 0;
  const body = new ReadableStream({
    pull(controller) {
      read += MB;
      controller.enqueue(new Uint8Array(MB));
    },
  });
  const answer = await runtime.handle(
    new Request("http://local/v1/events", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-length": String(8 * MB + 1) },
      body,
      duplex: "half",
    } as RequestInit),
  );
  assert.equal(answer.status, 413);
  assert.ok(read <= MB, `leu ${read} bytes`);
});

test("uma requisição recusada que nunca enviou o corpo recebe a resposta e uma conexão fechada", async () => {
  const server = serve(0);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  try {
    const socket = connect(port, "127.0.0.1");
    let said = "";
    socket.on("data", (chunk) => (said += chunk));
    socket.write(
      "POST /v1/events HTTP/1.1\r\nHost: local\r\n" +
        `Authorization: Bearer ${key}\r\nContent-Length: ${8 * MB + 1}\r\n\r\n`,
    );
    await once(socket, "close");
    assert.match(said, /^HTTP\/1\.1 413 /);
    assert.match(said, /connection: close/i);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
