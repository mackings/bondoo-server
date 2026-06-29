import app from "../dist/app.js";

export default function handler(req, res) {
  const originalPath = req.query?.path;
  if (typeof originalPath === "string") {
    const url = new URL(req.url ?? "/", "http://vercel.local");
    url.searchParams.delete("path");
    const query = url.searchParams.toString();
    req.url = `/${originalPath}${query ? `?${query}` : ""}`;
  }
  return app(req, res);
}
//