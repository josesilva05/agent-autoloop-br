// O cartão de incidente aberto na central é o ponto de controle: nada de um segundo agendador, banco de dados ou cursor
// de reconhecimento prévio.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

type Target = { id: string; name: string; url: string; contains: string };
type Observation = { ok: boolean; reason: string };
type Context = { events: { id: string }[]; open: { card: number; title: string }[] };
type Receipt = {
  notice?: { key: string; title: string; text: string }[];
  resolve?: { card: number; reason: string }[];
  events?: { id: string; type: string; subject: string; summary: string; detail: string; link: string }[];
};

export async function probe(target: Target, request = fetch): Promise<Observation> {
  // Falhas de rede e de leitura do corpo são observações sobre o site monitorado, não uma verificação bem-sucedida.
  try {
    const response = await request(target.url, {
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
      headers: { "user-agent": "agent-autoloop-site-check/1.0" },
    });
    if (response.status !== 200) return { ok: false, reason: `respondeu ${response.status}` };
    if (!(await response.text()).includes(target.contains))
      return { ok: false, reason: "não contém o conteúdo de saúde combinado" };
    return { ok: true, reason: "status 200 e contém o conteúdo de saúde combinado" };
  } catch {
    return { ok: false, reason: "falha de conexão ou de leitura, ou não concluiu em 20 segundos" };
  }
}

export function receipt(target: Target, observation: Observation, context: Context): Receipt {
  const title = `${target.name} está temporariamente inacessível`;
  const open = context.open.filter((card) => card.title === title);
  const changed = observation.ok ? open.length > 0 : open.length === 0;
  if (!changed) return {};
  const id = createHash("sha256")
    .update(JSON.stringify([target.id, context.events.map((e) => e.id), observation.ok]))
    .digest("hex");
  return {
    ...(observation.ok
      ? { resolve: open.map(({ card }) => ({ card, reason: `Inspeção recuperada: ${observation.reason}` })) }
      : {
          notice: [
            {
              key: `site-${target.id}`,
              title,
              text: "A inspeção automática encontrou uma anomalia e a entregou ao Agent de manutenção para investigar; este cartão será atualizado quando houver recuperação.",
            },
          ],
        }),
    events: [
      {
        id,
        type: observation.ok ? "site.recovered" : "site.down",
        subject: target.id,
        summary: observation.ok ? "Inspeção do site recuperada" : "Inspeção do site encontrou uma anomalia",
        detail: observation.reason,
        link: new URL(target.url).href,
      },
    ],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target: Target = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const url = new URL(target.url);
  if (
    !/^[A-Za-z0-9_.-]{1,60}$/.test(target.id) ||
    !target.name ||
    target.name.length > 100 ||
    !target.contains ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Verifique o site.json: preencha o número do site, o nome, o conteúdo essencial e um endereço HTTP sem credenciais, parâmetros de consulta nem fragmento",
    );
  }
  const context: Context = JSON.parse(readFileSync(process.env.AGENT_AUTOLOOP_CONTEXT!, "utf8"));
  const observation = await probe(target);
  console.log(
    `Inspeção concluída: ${observation.reason}\n\n\`\`\`agent-autoloop\n${JSON.stringify(receipt(target, observation, context))}\n\`\`\``,
  );
}
