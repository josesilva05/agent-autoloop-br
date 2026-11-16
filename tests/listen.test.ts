// Modos de falha: um endereço de escuta sem host vira todas as interfaces (uma central local silenciosamente aberta à
// rede), uma porta sozinha vira NaN e derruba a inicialização, e um endereço IPv6 é dividido no dois-pontos errado; uma
// porta que o Windows reservou (Hyper-V e WSL ocupam faixas delas) falha com um EACCES seco que não diz por quê nem o que fazer.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cantListen, parseListen } from "../host/config.ts";

test("um endereço de escuta é um host e uma porta, estritamente", () => {
  assert.deepEqual(parseListen("127.0.0.1:3350"), { host: "127.0.0.1", port: 3350 });
  assert.deepEqual(parseListen("[::1]:3350"), { host: "::1", port: 3350 });
  assert.deepEqual(parseListen("10.0.0.5:80"), { host: "10.0.0.5", port: 80 });
  for (const wrong of [
    ":3350",
    "3350",
    "127.0.0.1:",
    "127.0.0.1:0",
    "127.0.0.1:65536",
    "127.0.0.1:http",
    "127.0.0.1:3350:extra",
    " :3350",
  ]) {
    assert.throws(() => parseListen(wrong), Error, wrong);
  }
});

test("uma porta recusada no Windows diz que ela pode estar reservada e como conferir", () => {
  const refused = Object.assign(new Error("listen EACCES: permission denied 127.0.0.1:3350"), { code: "EACCES" });
  assert.match(cantListen(refused, "win32"), /reservada[\s\S]*netsh int ipv4 show excludedportrange protocol=tcp/);
  assert.doesNotMatch(cantListen(refused, "linux"), /netsh/);
});
