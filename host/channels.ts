// Um canal é um programa que vem até a central buscar cartões e faz um aplicativo de chat corresponder a eles:
// `plugins/<use>/channel.ts`, primeiro na pasta desta instalação e depois nos que já vêm com ela. Um canal em outra
// linguagem precisa apenas do protocolo.
import type { Hub } from "../protocol/client.ts";
import { loadPlugin } from "./plugins.ts";

export type Card = {
  id: number;
  version: number;
  ref: string | null;
  kind: "ask" | "notice";
  state: "open" | "decided" | "done" | "closed";
  title: string;
  text: string;
  options: string[];
  recommend: number | null;
  choice: number | null;
  answer: string | null;
  result: string | null;
  link: string | null;
  rule?: string;
};
export type ChannelContext = {
  hub: Pick<Hub, "nextCard" | "delivered" | "failed" | "answer">;
  options: Record<string, unknown>;
  log: (line: string) => void;
  signal: AbortSignal;
};

export async function loadChannel(use: string) {
  return (await loadPlugin(use, "channel")) as (context: ChannelContext) => Promise<void>;
}
