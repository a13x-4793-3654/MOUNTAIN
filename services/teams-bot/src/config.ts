export interface ContractSearchConfig {
  apiBaseUrl: string;
  connectionName: string;
  tenantId: string;
}

export interface BotConfig {
  clientId: string;
  clientSecret: string;
  tenantId: string;
  port: number;
  contractSearch?: ContractSearchConfig;
}

const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isGuid(value: unknown): value is string {
  return typeof value === "string" && guidPattern.test(value);
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value?.trim()) {
    throw new Error(`${name} is required. Configure the bot credentials before starting.`);
  }
  return value;
}

function guid(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name).trim();
  if (!isGuid(value)) {
    throw new Error(`${name} must be a GUID.`);
  }
  return value.toLowerCase();
}

export function readPort(env: NodeJS.ProcessEnv): number {
  const value = env.PORT ?? "3978";
  const port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  return port;
}

export function readConfig(env: NodeJS.ProcessEnv): BotConfig {
  const config: BotConfig = {
    clientId: guid(env, "CLIENT_ID"),
    clientSecret: required(env, "CLIENT_SECRET"),
    tenantId: guid(env, "TENANT_ID"),
    port: readPort(env),
  };
  if (env.MOUNTAIN_API_BASE_URL?.trim() || env.MOUNTAIN_OAUTH_CONNECTION_NAME?.trim()) {
    const value = required(env, "MOUNTAIN_API_BASE_URL").trim();
    if (!URL.canParse(value)) {
      throw new Error("MOUNTAIN_API_BASE_URL must be an HTTPS origin.");
    }
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password ||
        url.pathname !== "/" || url.search || url.hash) {
      throw new Error("MOUNTAIN_API_BASE_URL must be an HTTPS origin without credentials, path, query, or fragment.");
    }
    const connectionName = required(env, "MOUNTAIN_OAUTH_CONNECTION_NAME").trim();
    if (!/^[a-zA-Z0-9._-]{1,128}$/.test(connectionName)) {
      throw new Error("MOUNTAIN_OAUTH_CONNECTION_NAME must contain only letters, digits, dots, underscores, or hyphens.");
    }
    config.contractSearch = {
      apiBaseUrl: url.origin,
      connectionName,
      tenantId: config.tenantId,
    };
  }
  return config;
}
