import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { expandTilde } from "./home-path.js";

const HOME_DIR = resolve(homedir(), ".hydra-acp", "browser");
const PRIMARY_CONF = resolve(homedir(), ".hydra-acp", "browser.conf");
const LEGACY_CONF = resolve(homedir(), ".hydra-acp-browser.conf");

export function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
    return resolve(expandTilde(p, homedir()));
  }
  return p;
}

export const paths = {
  home(): string {
    return HOME_DIR;
  },
  linkFile(): string {
    return `${HOME_DIR}/link`;
  },
  pushFile(): string {
    return `${HOME_DIR}/push.json`;
  },
  configFile(): string {
    if (existsSync(PRIMARY_CONF)) {
      return PRIMARY_CONF;
    }
    if (existsSync(LEGACY_CONF)) {
      return LEGACY_CONF;
    }
    return PRIMARY_CONF;
  },
};
