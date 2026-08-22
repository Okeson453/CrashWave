#!/usr/bin/env node
/**
 * Quick startup validation script.
 * Checks critical paths before running docker build or deploying to production.
 *
 * Usage:
 *   node scripts/validate-startup.mjs
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = join(fileURLToPath(import.meta.url), '..');
const ROOT = join(__dirname, '..');

console.log('🔍 Startup Validation\n');

// Load .env
const envPath = join(ROOT, '.env');
try {
  dotenv.config({ path: envPath });
  console.log('✅ .env loaded');
} catch {
  console.log('⚠️  .env not found (OK if using Docker secrets or Railway vars)');
}

// Check required env vars
const required = {
  DATABASE_URL: 'PostgreSQL connection string (CRITICAL)',
};

const optional = {
  REDIS_URL: 'Redis connection (recommended)',
  TELEGRAM_BOT_TOKEN: 'Telegram bot token',
  TELEGRAM_OPERATOR_CHAT_ID: 'Telegram operator chat ID',
  TENANT_MASTER_KEY: 'Master encryption key (if using credentials)',
  PORT: 'Port to listen on (default: 9090)',
};

console.log('\n📋 Required Environment Variables:');
let requiredOk = true;
for (const [key, desc] of Object.entries(required)) {
  if (process.env[key]) {
    const val = key === 'DATABASE_URL' ? process.env[key].slice(0, 30) + '...' : '***';
    console.log(`  ✅ ${key}: ${val}`);
  } else {
    console.log(`  ❌ ${key}: NOT SET — ${desc}`);
    requiredOk = false;
  }
}

if (!requiredOk) {
  console.log(
    '\n❌ Missing required variables. Set them in .env or Railway Variables before deploying.'
  );
  process.exit(1);
}

console.log('\n📋 Optional Environment Variables:');
for (const [key, desc] of Object.entries(optional)) {
  if (process.env[key]) {
    console.log(`  ✅ ${key}: set`);
  } else {
    console.log(`  ⏭️  ${key}: not set (${desc})`);
  }
}

// Check source files
console.log('\n📂 Critical Source Files:');
const criticalFiles = [
  'src/index.ts',
  'src/config/validator.ts',
  'src/config/secret-files.ts',
  'src/platform/secret-vault.ts',
  'scripts/docker-entrypoint.sh',
  'scripts/run-migrations.mjs',
];

import('fs').then(({ existsSync }) => {
  let filesOk = true;
  for (const file of criticalFiles) {
    const path = join(ROOT, file);
    if (existsSync(path)) {
      console.log(`  ✅ ${file}`);
    } else {
      console.log(`  ❌ ${file}: MISSING`);
      filesOk = false;
    }
  }

  // Check Dockerfile
  const dockerfile = join(ROOT, 'Dockerfile');
  if (existsSync(dockerfile)) {
    console.log(`  ✅ Dockerfile`);
  } else {
    console.log(`  ❌ Dockerfile: MISSING`);
    filesOk = false;
  }

  // Check migrations directory
  console.log('\n🗄️  Migrations:');
  const migrationsDir = join(ROOT, 'migrations');
  if (existsSync(migrationsDir)) {
    const migrationsImport = import('fs').then(({ readdirSync }) => {
      const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
      if (files.length > 0) {
        console.log(`  ✅ ${files.length} SQL migration files found`);
        files.forEach((f) => console.log(`     - ${f}`));
      } else {
        console.log(`  ⚠️  No .sql files in migrations/ directory`);
      }
    });
  } else {
    console.log(`  ⚠️  migrations/ directory not found`);
  }

  if (filesOk) {
    console.log('\n✅ All critical files present\n');
    console.log(
      'Ready to build. Run: npm run build && docker build -t crash-automation .'
    );
  } else {
    console.log('\n❌ Some files missing. Check your build setup.\n');
    process.exit(1);
  }
});
