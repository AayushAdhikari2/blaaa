import { fileURLToPath } from 'node:url';

/** Absolute path to the automation-module root. Runtime state lives in <root>/.local. */
export const MODULE_ROOT = fileURLToPath(new URL('../', import.meta.url));

/** Absolute path to the gitignored runtime-state directory inside the module. */
export const LOCAL_STATE_DIR = fileURLToPath(new URL('../.local/', import.meta.url));

/** Absolute path to the standalone dashboard directory. */
export const DASHBOARD_DIR = fileURLToPath(new URL('../dashboard/', import.meta.url));
