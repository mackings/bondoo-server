import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";

const envText = readFileSync(new URL("../.env", import.meta.url), "utf8");
const envVars = [];

for (const rawLine of envText.split(/\r?\n/)) {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) continue;

  const separator = line.indexOf("=");
  if (separator <= 0) continue;

  const key = line.slice(0, separator).trim();
  let value = line.slice(separator + 1);
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  envVars.push(`${key}=${value}`);
}

const args = [
  "-u",
  "RENDER_API_KEY",
  "render",
  "services",
  "create",
  "--name",
  "bondoo-api",
  "--type",
  "web_service",
  "--repo",
  "https://github.com/mackings/bondoo-server",
  "--branch",
  "main",
  "--runtime",
  "node",
  "--plan",
  "free",
  "--build-command",
  "npm install && npm run build",
  "--start-command",
  "npm start",
  "--health-check-path",
  "/health",
  "--auto-deploy",
  "--confirm",
  "--output",
  "json",
];

for (const envVar of envVars) {
  args.push("--env-var", envVar);
}

const child = spawn("env", args, {
  stdio: ["ignore", "pipe", "pipe"],
  env: process.env,
});

let stdout = "";
let stderr = "";

child.stdout.on("data", (chunk) => {
  stdout += chunk;
});

child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

child.on("close", (code) => {
  if (stdout.trim()) process.stdout.write(stdout);
  if (stderr.trim()) process.stderr.write(stderr);
  process.exit(code ?? 1);
});
