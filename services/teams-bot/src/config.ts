export interface BotConfig {
  clientId: string;
  clientSecret: string;
  tenantId: string;
  port: number;
}

const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value?.trim()) {
    throw new Error(`${name} is required. Configure the bot credentials before starting.`);
  }
  return value;
}

function guid(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name).trim();
  if (!guidPattern.test(value)) {
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
  return {
    clientId: guid(env, "CLIENT_ID"),
    clientSecret: required(env, "CLIENT_SECRET"),
    tenantId: guid(env, "TENANT_ID"),
    port: readPort(env),
  };
}
