import { z } from "zod";

const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  RABBITMQ_URL: z.string().min(1),
  WHATSAPP_APP_SECRET: z.string().min(1),
  WHATSAPP_VERIFY_TOKEN: z.string().min(1),
  INTERNAL_SERVICE_TOKEN: z.string().min(32),
  UAE_PASS_ISSUER: z.string().url(),
});

export type AppConfig = z.infer<typeof configSchema>;

// Validates environment variables and applies defaults for the application configuration.
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  return configSchema.parse(source);
}
