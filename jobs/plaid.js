#!/usr/bin/env node
// Thin runner for Plaid. Default command: import.
// Examples:
//   node jobs/plaid.js
//   node jobs/plaid.js import
//   node jobs/plaid.js status
//   node jobs/plaid.js update "TD Canada Trust"
const { spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const cli = path.join(root, 'plaid', 'index.js');
const args = process.argv.slice(2);
const command = args.length ? args : ['import'];

const result = spawnSync(process.execPath, [cli, ...command], {
  stdio: 'inherit',
  cwd: root,
  env: process.env,
});

process.exit(result.status === null ? 1 : result.status);
