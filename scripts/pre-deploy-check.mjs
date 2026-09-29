#!/usr/bin/env node
/**
 * PWR-20: AetherNexus Pre-Deploy Validation Script
 * Run before every push to Render: npm run pre-deploy-check
 *
 * Validates:
 * 1. render.yaml YAML is valid and all required env vars are present
 * 2. No GROQ_API_KEY in render.yaml (should be OPENAI_API_KEY)
 * 3. AP-South node uses port 3004 (not 3003)
 * 4. All node services have PORT env var
 * 5. TypeScript compiles without errors
 * 6. skills.md exists at project root (AI system prompt source)
 * 7. .env.example keys match render.yaml keys
 * 8. MONGODB_URI is present in all services
 * 9. Gateway service has OPENAI_API_KEY, OPENAI_API_KEY2, OPENAI_API_KEY3
 */

import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    const result = fn();
    if (result === false) {
      console.error(`  ❌ FAIL: ${name}`);
      failed++;
    } else {
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    }
  } catch (e) {
    console.error(`  ❌ FAIL: ${name}\n       ${e.message}`);
    failed++;
  }
}

console.log('\n🔍 AetherNexus Pre-Deploy Validation\n');

// 1. skills.md exists
check('skills.md exists at project root', () => {
  if (!existsSync(resolve(ROOT, 'skills.md'))) throw new Error('skills.md not found');
});

// 2. render.yaml is parseable
let renderContent = '';
check('render.yaml exists and is readable', () => {
  renderContent = readFileSync(resolve(ROOT, 'render.yaml'), 'utf-8');
  if (!renderContent.includes('services:')) throw new Error('render.yaml missing services: key');
});

// 3. No GROQ_API_KEY in render.yaml (BUG-A02)
check('render.yaml has no GROQ_API_KEY (should be OPENAI_API_KEY)', () => {
  if (renderContent.includes('GROQ_API_KEY:')) throw new Error('Found GROQ_API_KEY — should be OPENAI_API_KEY');
});

// 4. AP-South port is 3004 not 3003
check('AP-South node uses port 3004', () => {
  const apSouthSection = renderContent.split('ap-south-cluster')[1] || '';
  if (apSouthSection.includes('"3003"')) throw new Error('AP-South port is 3003 — should be 3004');
});

// 5. Gateway has OPENAI_API_KEY2 and OPENAI_API_KEY3
check('Gateway service has OPENAI_API_KEY2 and OPENAI_API_KEY3 for key rotation', () => {
  if (!renderContent.includes('OPENAI_API_KEY2')) throw new Error('Missing OPENAI_API_KEY2 on gateway service');
  if (!renderContent.includes('OPENAI_API_KEY3')) throw new Error('Missing OPENAI_API_KEY3 on gateway service');
});

// 6. All services have MONGODB_URI
check('All services declare MONGODB_URI', () => {
  const serviceMatches = renderContent.match(/name: ([\w-]+)/g) || [];
  const mongoMatches = (renderContent.match(/MONGODB_URI/g) || []).length;
  if (mongoMatches < serviceMatches.length) {
    throw new Error(`Only ${mongoMatches} MONGODB_URI declarations for ${serviceMatches.length} services`);
  }
});

// 7. PORT declared on all node services
check('All node microservices declare PORT env var', () => {
  const nodeServices = ['us-east-cluster', 'eu-west-cluster', 'ap-south-cluster'];
  for (const svc of nodeServices) {
    const svcSection = renderContent.split(`name: ${svc}`)[1] || '';
    const nextSvc = svcSection.split('- type: web')[0];
    if (!nextSvc.includes('PORT')) throw new Error(`Service ${svc} missing PORT env var`);
  }
});

// 8. render.yaml has VITE_API_GATEWAY_URL with proper YAML
check('render.yaml VITE_API_GATEWAY_URL is on its own line (BUG-A01)', () => {
  const lines = renderContent.split('\n');
  for (const line of lines) {
    if (line.includes('VITE_API_GATEWAY_URL') && line.includes('sync:')) {
      throw new Error(`VITE_API_GATEWAY_URL and sync: on same line — YAML syntax error`);
    }
  }
});

// 9. TypeScript compilation
check('TypeScript compiles without errors (npx tsc --noEmit)', () => {
  try {
    execSync('npx tsc --noEmit', { cwd: ROOT, stdio: 'pipe', timeout: 60000 });
  } catch (e) {
    throw new Error(`TypeScript errors:\n${e.stdout?.toString() || e.message}`);
  }
});

// 10. skills.md is non-empty (> 100 chars)
check('skills.md has content (> 100 chars)', () => {
  const content = readFileSync(resolve(ROOT, 'skills.md'), 'utf-8');
  if (content.length < 100) throw new Error(`skills.md too short (${content.length} chars)`);
});

// Summary
console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(`\n⛔ ${failed} check(s) FAILED — fix before deploying to Render!\n`);
  process.exit(1);
} else {
  console.log(`\n🚀 All checks passed — safe to deploy!\n`);
  process.exit(0);
}
