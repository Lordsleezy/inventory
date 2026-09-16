import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: repoRoot,
  transpilePackages: ["@floor/domain", "@floor/inventree", "@floor/auth", "@floor/importer"],
  serverExternalPackages: ["pdf-lib"],
  allowedDevOrigins: ["127.0.0.1", "localhost"],
};

export default nextConfig;
