// O menor canal: cada cartão vira algumas linhas num arquivo. Alguém responde com `agent-autoloop answer`, porque um
// arquivo não tem botões.
//   rules.json:  "channels": { "cards": { "name": "Arquivo" } }
//   config.json: "channels": { "cards": { "use": "hello-channel", "key": "…", "file": "/caminho/absoluto/cards.txt" } }
import { appendFileSync } from "node:fs";

type Card = {
  id: number;
  version: number;
  ref: string | null;
  title: string;
  text: string;
  options: string[];
  rule?: string;
};
type Context = {
  hub: {
    nextCard(wait: number): Promise<{ card: Card | null }>;
    delivered(card: number, version: number, ref: string | null): Promise<unknown>;
    failed(card: number, version: number, error: string): Promise<unknown>;
  };
  options: Record<string, unknown>;
  log: (line: string) => void;
  signal: AbortSignal;
};

// Os cartões vêm de muitas regras: diga de qual, a menos que o título já seja o nome dela.
const words = ({ id, title, text, options, rule }: Card) =>
  [
    `#${id} ${title}`,
    ...(rule && rule !== title ? [`Fonte: ${rule}`] : []),
    text,
    ...options.map((option, index) => `  ${index + 1}. ${option}`),
    "",
  ].join("\n");

export default async function helloChannel({ hub, options, log, signal }: Context) {
  while (!signal.aborted) {
    const { card } = await hub.nextCard(50);
    if (!card) continue;
    // Um cartão com ref mudou depois de ter sido enviado. Um arquivo não pode mudar o que disse, então resta o relatório.
    if (card.ref) {
      await hub.delivered(card.id, card.version, card.ref);
      continue;
    }
    try {
      appendFileSync(options.file as string, words(card));
      await hub.delivered(card.id, card.version, `file-${card.id}`);
    } catch (error) {
      log(`o cartão ${card.id} não foi escrito: ${error}`);
      await hub.failed(card.id, card.version, String(error));
    }
  }
}
