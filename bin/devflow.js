#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

import { createRun, runUntilPauseOrDone, approvePlan, approvePrd } from '../devflow-kit/lib/pipeline.mjs';
import { loadRun } from '../devflow-kit/lib/runStore.mjs';
import { startServer } from '../devflow-kit/server.mjs';

function parseArgs(argv) {
  const args = [...argv];
  const out = { _: [] };
  while (args.length) {
    const a = args.shift();
    if (!a) continue;
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2);
    const value = args[0] && !args[0].startsWith('--') ? args.shift() : true;
    out[key] = value;
  }
  return out;
}

function promptYesNo(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      const a = String(answer || '').trim().toLowerCase();
      resolve(a === 'y' || a === 'yes' || a === 'ok' || a === 'true');
    });
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);
  const subcmd = parsed._[0] || null;

  const repoRoot = process.cwd();

  if (subcmd === 'server') {
    const port = Number(parsed.port || 4170);
    const host = typeof parsed.host === 'string' ? parsed.host : '127.0.0.1';
    await startServer({ repoRoot, port, host });
    return;
  }

  if (subcmd === 'status') {
    const id = parsed._[1];
    if (!id) throw new Error('Usage: devflow status <run_id>');
    const run = await loadRun(repoRoot, id);
    process.stdout.write(JSON.stringify({ id: run.id, phase: run.phase, status: run.status, artifacts: run.artifacts }, null, 2) + '\n');
    return;
  }

  const reqFile = parsed['req-file'] === true ? null : parsed['req-file'];
  const runId = parsed['run-id'] === true ? null : parsed['run-id'];
  const requirementText = parsed._.join(' ');

  if (!runId && !reqFile && !requirementText.trim()) {
    throw new Error('Usage: devflow "<需求文字>"  或  devflow --req-file <file>  或  devflow status <run_id>  或  devflow server');
  }

  let run = runId
    ? await loadRun(repoRoot, runId)
    : await createRun({
        repoRoot,
        requirementText,
        reqFilePath: reqFile || null,
        config: {
          contextLimits: {
            maxFiles: Number(parsed['max-files'] || 16),
            maxTotalChars: Number(parsed['max-chars'] || 60_000),
            maxCharsPerFile: Number(parsed['max-chars-per-file'] || 12_000),
          },
        },
      });

  while (true) {
    run = await runUntilPauseOrDone({ repoRoot, runId: run.id });

    if (run.status === 'awaiting_plan_approval') {
      const planPath = run.artifacts?.planPath;
      process.stdout.write(`\nPlan ready: ${planPath}\n`);
      const ok = await promptYesNo('是否同意此 Plan 進入下一階段？ [y/N] ');
      run = await approvePlan({ repoRoot, runId: run.id, approved: ok, note: ok ? null : 'rejected via CLI' });
      continue;
    }

    if (run.status === 'awaiting_prd_approval') {
      const prdPath = run.artifacts?.prdPath;
      process.stdout.write(`\nPRD ready: ${prdPath}\n`);
      const ok = await promptYesNo('是否同意此 PRD 進入下一階段？ [y/N] ');
      run = await approvePrd({ repoRoot, runId: run.id, approved: ok, note: ok ? null : 'rejected via CLI' });
      continue;
    }

    if (run.status === 'done') {
      process.stdout.write(`\nDone. run_id=${run.id}\n`);
      process.stdout.write(`- plan: ${run.artifacts?.planPath}\n`);
      process.stdout.write(`- prd:  ${run.artifacts?.prdPath}\n`);
      return;
    }

    if (run.status === 'error' || run.phase === 'error') {
      process.stderr.write(`\nRun failed. run_id=${run.id}\n`);
      process.stderr.write(JSON.stringify(run.errors?.slice(-1)?.[0] || run.errors || {}, null, 2) + '\n');
      process.exitCode = 1;
      return;
    }

    // If paused for any other reason, stop.
    process.stdout.write(`\nPaused. phase=${run.phase} status=${run.status} run_id=${run.id}\n`);
    return;
  }
}

main().catch((err) => {
  process.stderr.write(String(err?.stack || err) + '\n');
  process.exitCode = 1;
});
