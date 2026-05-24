#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { BudgeterBridge } from "./bridge.js";
import { DEFAULT_RULE, loadRule, type RuleFunction } from "./rule.js";
import { logger, setDebug } from "./util/log.js";

const log = logger("main");

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      readFileSync(resolve(here, "../package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`hydra-acp-budgeter ${readVersion()}\n`);
    return;
  }

  const config = loadConfig();
  setDebug(config.debug);

  let currentRule: RuleFunction = DEFAULT_RULE;
  currentRule = await loadRule(config.ruleConfigPath);

  const bridge = new BudgeterBridge({
    daemonWsUrl: config.hydraWsUrl,
    token: config.hydraToken,
    softLimit: config.softLimit,
    hardLimit: config.hardLimit,
    currency: config.currency,
    getRule: () => currentRule,
  });
  bridge.start();

  process.on("SIGHUP", () => {
    log.info(`SIGHUP — reloading rule from ${config.ruleConfigPath}`);
    loadRule(config.ruleConfigPath)
      .then((rule) => {
        currentRule = rule;
        bridge.refreshRule();
        log.info("rule reload complete");
      })
      .catch((err: unknown) => {
        log.warn(`rule reload failed: ${(err as Error).message}`);
      });
  });

  const shutdown = (sig: string): void => {
    log.info(`${sig} received — shutting down`);
    bridge.stop();
    setTimeout(() => process.exit(0), 200).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  log.info(
    `hydra-acp-budgeter up; daemon=${config.hydraDaemonUrl} soft=${config.softLimit} hard=${config.hardLimit} ${config.currency} rule=${config.ruleConfigPath}`,
  );
}

main().catch((err) => {
  process.stderr.write(`hydra-acp-budgeter: ${(err as Error).message}\n`);
  process.exit(1);
});
