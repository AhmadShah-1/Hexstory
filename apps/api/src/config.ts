import { z } from 'zod';

/**
 * All configuration comes from environment variables, injected by Doppler (`doppler run`).
 * See .env.example for the list. The process refuses to start with invalid config.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  DATABASE_URL: z.string().min(1),
  APP_ORIGIN: z.url(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  ADMIN_EMAILS: z
    .string()
    .default('')
    .transform((v) => v.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)),
  UPLOAD_DIR: z.string().default('./uploads'),
  TRUST_PROXY: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration (check Doppler secrets):\n${issues}`);
  }
  return parsed.data;
}

export const isGoogleConfigured = (config: Config) => !!(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET);
