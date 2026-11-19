import path from 'node:path';
import { z } from 'zod';

/** Free-tier Flash model. Override with GEMINI_MODEL if Google retires it (GET /api/v1/llm/models lists what your key can use). */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash';

const bool = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v === '' ? undefined : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const schema = z.object({
  APP_ENV: z.string().default('local'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().default(8000),
  DATABASE_PATH: z.string().default('./playtest_ai.db'),
  STORAGE_DIR: z.string().default('./storage'),
  MAX_APK_SIZE_MB: z.coerce.number().positive().default(300),
  ANDROID_SDK_ROOT: z.string().optional().default(''),
  MAX_CONCURRENT_EMULATORS: z.coerce.number().int().min(1).default(1),
  EMULATOR_RAM_MB: z.coerce.number().int().min(1024).default(2048),
  EMULATOR_GPU_MODE: z.enum(['host', 'swiftshader_indirect', 'angle_indirect', 'auto', 'off']).default('host'),
  EMULATOR_HEADLESS: bool.default('true'),
  /** Start emulators from a saved clean snapshot (seconds instead of a 1-2 min cold boot). */
  EMULATOR_FAST_BOOT: bool.default('true'),
  /** CPU cores per emulator; 0 = auto (half the host threads, 2-4). */
  EMULATOR_CORES: z.coerce.number().int().min(0).max(16).default(0),
  DEVICE_BOOT_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(180),
  HOST_RESERVED_RAM_GB: z.coerce.number().positive().default(4.5),
  APPIUM_SERVER_URL: z.string().default('http://127.0.0.1:4723'),
  DEFAULT_UIAUTOMATOR2_SYSTEM_PORT: z.coerce.number().int().default(8200),
  JAVA_HOME: z.string().optional().default(''),
  /** Flutter SDK folder (auto-detected from PATH when empty). */
  FLUTTER_ROOT: z.string().optional().default(''),
  /** scrcpy executable for screen mirroring (auto-detected from PATH / winget when empty). */
  SCRCPY_PATH: z.string().optional().default(''),
  /** Folder for new AVD data (e.g. M:\\Android\\avd). Empty = avdmanager default (~/.android/avd). */
  AVD_STORAGE_DIR: z.string().optional().default(''),
  SYSTEM_IMAGES_DIR: z.string().optional().default(''),
  LLM_PROVIDER: z.preprocess((v) => v || undefined, z.enum(['gemini']).default('gemini')),
  GEMINI_API_KEY: z.string().optional().default(''),
  GEMINI_MODEL: z.string().optional().transform((v) => v || DEFAULT_GEMINI_MODEL),
  OPENAI_API_KEY: z.string().optional().default(''),
  OPENAI_MODEL: z.string().optional().default(''),
  METRICS_INTERVAL_MS: z.coerce.number().int().min(500).default(2000),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const env = parsed.data;

export const config = {
  ...env,
  EMULATOR_HEADLESS: env.EMULATOR_HEADLESS ?? true,
  EMULATOR_FAST_BOOT: env.EMULATOR_FAST_BOOT ?? true,
  DATABASE_PATH: path.resolve(env.DATABASE_PATH),
  STORAGE_DIR: path.resolve(env.STORAGE_DIR),
};

export type AppConfig = typeof config;
