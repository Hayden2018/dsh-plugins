import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = path.dirname(fileURLToPath(import.meta.url));
const defaultShotDir = path.resolve(packageDir, '..', 'shots');

export const SHOT_DIR = path.resolve(process.env.PW_SHOT_DIR || defaultShotDir);
export const CHROMIUM_PATH = process.env.PW_CHROMIUM_PATH || undefined;
export const CDP_ENDPOINT = process.env.PW_CDP_ENDPOINT || undefined;
export const CDP_PAGE = process.env.PW_CDP_PAGE || undefined;
export const CONNECT_TIMEOUT_MS =
  Number(process.env.PW_CDP_TIMEOUT) > 0 ? Number(process.env.PW_CDP_TIMEOUT) : 90000;
export const FAST_TIMEOUT_MS = 3000;
export const RTT_BUDGET_MS =
  Number(process.env.PW_RTT_TIMEOUT) > 0 ? Number(process.env.PW_RTT_TIMEOUT) : 1500;
export const CLOSE_BUDGET_MS = 10000;
export const BROWSER_LOCALE = process.env.PW_LANG === 'en' ? 'en-US' : 'zh-CN';
