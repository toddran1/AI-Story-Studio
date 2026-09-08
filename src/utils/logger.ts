import pino from "pino";
export const logger = pino({ level: process.env.VITEST ? "silent" : process.env.LOG_LEVEL ?? "info", redact: ["apiKey", "*.apiKey", "headers.authorization"] });
