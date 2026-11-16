// O menor plugin de webhook, para um sistema inventado que faz POST de { "id", "kind", "order", "note" } e assina o corpo
// com HMAC-SHA256 no cabeçalho x-shop-signature. Ele apenas traduz: não faz requisições e não pode ser assíncrono.
//   rules.json:  "sources": { "shop": { "name": "shop", "adapter": "hello-source" } }
//   secrets.env: AGENT_AUTOLOOP_SECRET_SHOP=…
// O endereço a dar para o outro lado é /v1/in/shop.
import { createHmac, timingSafeEqual } from "node:crypto";

type Input = { headers: Record<string, string | string[] | undefined>; body: string; secret: string };

export default function helloSource({ headers, body, secret }: Input) {
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const given = Buffer.from(String(headers["x-shop-signature"] ?? ""));
  if (!secret || given.length !== expected.length || !timingSafeEqual(given, expected)) throw new Error("signature");
  const { id, kind, order, note } = JSON.parse(body);
  if (kind === "ping") return [];
  return [
    { id: String(id), type: `order.${kind}`, subject: `order-${order}`, summary: String(note ?? "").slice(0, 200) },
  ];
}
