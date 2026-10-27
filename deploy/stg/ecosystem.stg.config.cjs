/** PM2 staging (AWS staging EC2) — separate names from production. */
const base = process.env.STG_BASE || "/var/www";

module.exports = {
  apps: [
    {
      name: "babybarn-stg-api",
      cwd: `${base}/BabyBarn-Backend`,
      script: "index.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "512M",
      env: { NODE_ENV: "production", PORT: "5000", APP_ENV: "staging" },
    },
    {
      name: "babybarn-stg-store",
      cwd: `${base}/BabyBarn-Frontend`,
      script: "node_modules/next/dist/bin/next",
      args: "start -p 3000",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "512M",
      env: { NODE_ENV: "production", PORT: "3000", APP_ENV: "staging" },
    },
    {
      name: "babybarn-stg-admin",
      cwd: `${base}/BabyBarn-Admin`,
      script: "node_modules/next/dist/bin/next",
      args: "start -p 3001",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "512M",
      env: { NODE_ENV: "production", PORT: "3001", APP_ENV: "staging" },
    },
  ],
};
