import { homedir } from "node:os";
import { join } from "node:path";

const xdg = (envVar: string, fallback: string): string =>
  process.env[envVar]?.trim() || join(homedir(), fallback);

export const configDir = (): string => join(xdg("XDG_CONFIG_HOME", ".config"), "syncy");
export const stateDir = (): string => join(xdg("XDG_STATE_HOME", ".local/state"), "syncy");

export const configFile = (): string => join(configDir(), "config.toml");
export const stateFile = (): string => join(stateDir(), "state.json");
export const historyFile = (): string => join(stateDir(), "history.jsonl");
export const logDir = (): string => join(stateDir(), "logs");

export const diffDir = (): string => join(stateDir(), "diffs");
