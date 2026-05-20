/**
 * Local credential storage at ~/.warp/config.json
 * Handles reading, writing, and clearing the stored API key.
 */
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface WarpConfig {
  api_key: string;
  email: string;
  base_url?: string;
}

function configDir(): string {
  return join(homedir(), ".warp");
}

function configFile(): string {
  return join(configDir(), "config.json");
}

export function loadConfig(): WarpConfig | null {
  try {
    const raw = readFileSync(configFile(), "utf8");
    const parsed = JSON.parse(raw) as WarpConfig;
    if (parsed.api_key && parsed.email) return parsed;
    return null;
  } catch {
    return null;
  }
}

export function saveConfig(config: WarpConfig): void {
  const dir = configDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(configFile(), JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
}

export function clearConfig(): boolean {
  try {
    unlinkSync(configFile());
    return true;
  } catch {
    return false;
  }
}

export function configPath(): string {
  return configFile();
}
