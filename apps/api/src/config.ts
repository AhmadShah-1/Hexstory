import { z } from 'zod';
import { resolveSupportLinks } from '@hexstory/shared';

/** Unset and empty both mean "not configured". */
const unsetIfEmpty = <T extends z.ZodType>(type: T) => z.preprocess((v) => (v === '' ? undefined : v), type.optional());
const optional = unsetIfEmpty(z.string().trim().min(1));

/**
 * All configuration comes from environment variables: Doppler (`doppler run`) locally, Vercel
 * project environment variables in deployments. See .env.example and docs/DEPLOYMENT.md for the
 * list. The process refuses to start with invalid config.
 */
const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().default(3000),
    /** Application connection string. On Neon this is the pooled (PgBouncer) URL. */
    DATABASE_URL: z.string().min(1),
    /** Connections per process. Kept small on Vercel, where many instances each hold a pool. */
    DB_POOL_MAX: unsetIfEmpty(z.coerce.number().int().min(1).max(50)),
    APP_ORIGIN: z.url(),
    GOOGLE_CLIENT_ID: optional,
    GOOGLE_CLIENT_SECRET: optional,
    ADMIN_EMAILS: z
      .string()
      .default('')
      .transform((v) => v.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)),
    STORAGE_BACKEND: z.enum(['local', 'r2']).default('local'),
    UPLOAD_DIR: z.string().default('./uploads'),
    R2_ENDPOINT: unsetIfEmpty(z.url()),
    R2_BUCKET: optional,
    R2_STAGING_BUCKET: optional,
    R2_ACCESS_KEY_ID: optional,
    R2_SECRET_ACCESS_KEY: optional,
    R2_PUBLIC_BASE_URL: unsetIfEmpty(z.url()),
    /** Shared state for multiple instances (chat fan-out, presence, rate limits). Optional locally. */
    REDIS_URL: unsetIfEmpty(z.string().regex(/^rediss?:\/\//, 'must start with redis:// or rediss://')),
    /** Trust X-Forwarded-For for the client IP. Only behind a proxy that overwrites it (Vercel does). */
    TRUST_PROXY: z
      .string()
      .default('false')
      .transform((v) => v === 'true'),
    /**
     * Public links for the Support page (not secrets). Validated in the transform below: an invalid
     * value hides that option and logs a warning instead of stopping the site.
     */
    STRIPE_SUPPORT_URL: optional,
    PAYPAL_SUPPORT_URL: optional,
    /** Photon geocoder the place search queries (server-side). Self-host or switch by changing it. */
    GEOCODER_URL: z.preprocess((v) => (v === '' ? undefined : v), z.url().default('https://photon.komoot.io')),
    /**
     * Moderators' resource usage dashboard (docs/DEPLOYMENT.md, "Resource usage dashboard"). All
     * optional. Parsed and checked in usage/settings.ts: a bad value is reported on the dashboard
     * and ignored, never stops the site. The two credentials are read-only monitoring secrets,
     * separate from the app's own.
     */
    USAGE_CACHE_SECONDS: optional,
    USAGE_WARN_PERCENT: optional,
    USAGE_CRITICAL_PERCENT: optional,
    USAGE_NEON_API_KEY: optional,
    USAGE_NEON_PROJECT_ID: optional,
    USAGE_NEON_PLAN: optional,
    USAGE_LIMIT_NEON_STORAGE_GB: optional,
    USAGE_LIMIT_NEON_COMPUTE_CU_HOURS: optional,
    USAGE_LIMIT_NEON_TRANSFER_GB: optional,
    USAGE_LIMIT_REDIS_MEMORY_MB: optional,
    USAGE_LIMIT_REDIS_CONNECTIONS: optional,
    USAGE_LIMIT_REDIS_OPS_PER_SEC: optional,
    USAGE_CLOUDFLARE_API_TOKEN: optional,
    USAGE_CLOUDFLARE_ACCOUNT_ID: optional,
    USAGE_LIMIT_R2_STORAGE_GB_MONTH: optional,
    USAGE_LIMIT_R2_CLASS_A_MONTH: optional,
    USAGE_LIMIT_R2_CLASS_B_MONTH: optional,
    /** Set by Vercel on every deployment. */
    VERCEL: z.string().optional(),
    VERCEL_ENV: unsetIfEmpty(z.enum(['production', 'preview', 'development'])),
  })
  .superRefine((c, ctx) => {
    const require = (key: keyof typeof c, why: string) => {
      if (!c[key]) ctx.addIssue({ code: 'custom', path: [key], message: `required ${why}` });
    };
    if (c.STORAGE_BACKEND === 'r2') {
      for (const key of ['R2_ENDPOINT', 'R2_BUCKET', 'R2_STAGING_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_PUBLIC_BASE_URL'] as const) {
        require(key, 'when STORAGE_BACKEND=r2');
      }
    }
    if (c.VERCEL === '1') {
      require('REDIS_URL', 'on Vercel: instances share chat, presence and rate limits through it');
      if (c.STORAGE_BACKEND !== 'r2') {
        ctx.addIssue({ code: 'custom', path: ['STORAGE_BACKEND'], message: 'must be r2 on Vercel: function disk is not durable' });
      }
    }
  })
  .transform((c) => ({
    ...c,
    /** Which database this deployment may use; must match the marker `npm run migrate` wrote. */
    DEPLOY_ENV: c.VERCEL_ENV ?? 'development',
    DB_POOL_MAX: c.DB_POOL_MAX ?? (c.VERCEL === '1' ? 5 : 10),
    /** Validated Support page links (`links`) and why any configured value was ignored (`problems`). */
    SUPPORT: resolveSupportLinks({ stripe: c.STRIPE_SUPPORT_URL, paypal: c.PAYPAL_SUPPORT_URL }),
  }));

export type Config = z.infer<typeof schema>;

/** Defaults that differ on Vercel, applied only where the variable is unset. */
const VERCEL_DEFAULTS = { NODE_ENV: 'production', TRUST_PROXY: 'true', STORAGE_BACKEND: 'r2' } as const;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const input = env.VERCEL === '1' ? { ...VERCEL_DEFAULTS, ...definedOnly(env) } : env;
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration (check Doppler secrets or Vercel environment variables):\n${issues}`);
  }
  return parsed.data;
}

const definedOnly = (env: NodeJS.ProcessEnv) => Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));

export const isGoogleConfigured = (config: Config) => !!(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET);
