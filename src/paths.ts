import { homedir } from "node:os";
import { resolve } from "node:path";

// hydra-acp injects HYDRA_ACP_HOME when it spawns transformers; this file
// is invoked both in that role and as a one-shot subcommand from the
// user's shell, so fall back to ~/.hydra-acp when the env isn't set.
function hydraHome(): string {
  return process.env.HYDRA_ACP_HOME ?? resolve(homedir(), ".hydra-acp");
}

export function stateFilePath(): string {
  return resolve(hydraHome(), "budgeter-cost.json");
}
