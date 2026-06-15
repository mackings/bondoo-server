const apiBaseUrl = process.env.API_BASE_URL ?? "http://localhost:4000";

const checks = [
  ["GET", "/health", 200],
  ["GET", "/config", 200],
  ["GET", "/me/profile", 401],
  ["GET", "/me/wallets", 401],
  ["POST", "/me/otp/email/send", 401],
  ["POST", "/me/otp/email/verify", 401],
  ["GET", "/chat/conversations", 401],
  ["GET", "/chat/users/search", 401],
  ["GET", "/escrow", 401],
  ["POST", "/escrow", 401],
  ["GET", "/admin/escrow", 401],
  ["GET", "/admin/deposits", 401],
];

let failures = 0;

for (const [method, path, expected] of checks) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: method === "POST" ? "{}" : undefined,
  });
  const ok = response.status === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${method} ${path} -> ${response.status}, expected ${expected}`);
}

if (failures > 0) process.exitCode = 1;
