// Onde esta instalação guarda suas coisas: rules.json, config.json, secrets.env, hub.db e as rodadas do worker.
import { homedir } from "node:os";
import path from "node:path";

export const HOME = path.resolve(process.env.AGENT_AUTOLOOP_HOME ?? path.join(homedir(), ".agent-autoloop"));
export const RULES_FILE = path.resolve(process.env.AGENT_AUTOLOOP_RULES ?? path.join(HOME, "rules.json"));
