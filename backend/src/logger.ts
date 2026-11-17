import fs from "node:fs";
import path from "node:path";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";

const logDir = path.join(config.dataDir, "logs");
const MAX_BODY_CHARS = 4000;
// Keys whose values must never reach a log file.
const SECRET_KEYS = new Set(["secretKey", "privateKey", "secret"]);

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SECRET_KEYS.has(k) ? "***" : redact(v)]),
    );
  }
  return value;
}

function stringify(value: unknown): string {
  if (value === undefined) return "";
  const s = JSON.stringify(redact(value));
  return s.length > MAX_BODY_CHARS ? `${s.slice(0, MAX_BODY_CHARS)}… (${s.length} chars)` : s;
}

function writeLine(line: string) {
  try {
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, `api-${new Date().toISOString().slice(0, 10)}.log`), line + "\n");
  } catch (e) {
    console.error("Failed to write API log:", e);
  }
}

/** Log every /api request with its body, response status, duration and response body. */
export function apiLogger(req: Request, res: Response, next: NextFunction) {
  if (!req.path.startsWith("/api")) return next();
  const started = Date.now();
  let responseBody: unknown;

  const json = res.json.bind(res);
  res.json = (body: unknown) => {
    responseBody = body;
    return json(body);
  };

  res.on("finish", () => {
    const ms = Date.now() - started;
    const file = (req as Request & { file?: Express.Multer.File }).file;
    const request = {
      ...(req.query && Object.keys(req.query).length ? { query: req.query } : {}),
      ...(req.body && Object.keys(req.body).length ? { body: req.body } : {}),
      ...(file ? { file: { name: file.originalname, type: file.mimetype, bytes: file.size } } : {}),
    };
    const ts = new Date().toISOString();
    const head = `${ts} ${req.method} ${req.originalUrl} → ${res.statusCode} (${ms} ms)`;
    const reqStr = Object.keys(request).length ? stringify(request) : "";
    const resStr = stringify(responseBody);

    writeLine([head, reqStr && `  request:  ${reqStr}`, resStr && `  response: ${resStr}`].filter(Boolean).join("\n"));

    const color = res.statusCode >= 500 ? "\x1b[31m" : res.statusCode >= 400 ? "\x1b[33m" : "\x1b[32m";
    console.log(`${color}${head}\x1b[0m`);
    if (reqStr) console.log(`  request:  ${reqStr}`);
    if (resStr) console.log(`  response: ${resStr.length > 600 ? `${resStr.slice(0, 600)}…` : resStr}`);
  });

  next();
}
