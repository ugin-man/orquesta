import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function writeCanonicalState(root: string, includeReviewer: boolean): Promise<void> {
  const now = new Date();
  const recent = new Date(now.getTime() - 15_000).toISOString();
  const started = new Date(now.getTime() - 25_000).toISOString();
  const state = path.join(root, '.orquesta', 'state');
  const vision = path.join(root, '.orquesta', 'vision');
  const failures = path.join(root, '.orquesta', 'failures');
  await Promise.all([mkdir(state, { recursive: true }), mkdir(vision, { recursive: true }), mkdir(failures, { recursive: true })]);

  const agents = [
    { agent_id: 'orchestrator', role: 'orchestrator', display_name: 'Coordinator', status: 'active', current_task: null, mission: 'Coordinate the live repository.', last_heartbeat: recent },
    { agent_id: 'builder', role: 'implementation', display_name: 'Builder', status: 'active', current_task: 'LIVE-1', assigned_by_agent_id: 'orchestrator', mission: 'Build the integration.', last_heartbeat: recent },
    ...(includeReviewer ? [{ agent_id: 'reviewer', role: 'review', display_name: 'Reviewer', status: 'standby', current_task: null, assigned_by_agent_id: 'orchestrator', mission: 'Review the result.' }] : [])
  ];
  const tasks = [{
    task_id: 'LIVE-1', title: 'Wire canonical repository state', state: 'in_progress', owner_agent_id: 'builder',
    assigned_by_agent_id: 'orchestrator', handoff_sent_at: started,
    handoff_attempts: [{ status: 'accepted', turn_start_status: 'verified', turn_started_at: started, actual_model: null }],
    progress_observed: true, progress_summary: 'Watching canonical files.', updated_at: recent
  }];
  await Promise.all([
    writeFile(path.join(state, 'agents.json'), `${JSON.stringify({ updated_at: now.toISOString(), agents }, null, 2)}\n`, 'utf8'),
    writeFile(path.join(state, 'tasks.json'), `${JSON.stringify({ updated_at: now.toISOString(), tasks }, null, 2)}\n`, 'utf8'),
    writeFile(path.join(state, 'sessions.json'), `${JSON.stringify({ synced_at: now.toISOString(), sessions: [{ agent_id: 'builder', status: 'active', last_seen: recent }] }, null, 2)}\n`, 'utf8'),
    writeFile(path.join(vision, 'questions.json'), `${JSON.stringify({ questions: [{ question_id: 'LIVE-Q1', status: 'pending', question: 'Approve integration result?', source_agent_id: 'orchestrator', created_at: recent }] }, null, 2)}\n`, 'utf8'),
    writeFile(path.join(failures, 'incidents.json'), '{"incidents":[]}\n', 'utf8'),
    writeFile(path.join(state, 'events.jsonl'), `${JSON.stringify({ ts: recent, type: 'progress_observed', task_id: 'LIVE-1', summary: 'Canonical state loaded.' })}\n`, 'utf8')
  ]);
}

test('loads a real .orquesta repository read-only and follows canonical file changes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'orquesta-electron-live-'));
  const userData = await mkdtemp(path.join(os.tmpdir(), 'orquesta-electron-user-'));
  await writeCanonicalState(root, false);
  const agentsPath = path.join(root, '.orquesta', 'state', 'agents.json');
  const tasksPath = path.join(root, '.orquesta', 'state', 'tasks.json');
  const originalTasks = await readFile(tasksPath, 'utf8');

  const desktop = await electron.launch({
    args: [`--user-data-dir=${userData}`, '--lang=en-US', '.'],
    cwd: appRoot,
    env: { ...process.env, ORQUESTA_E2E: '1', ORQUESTA_E2E_PROJECT_ROOT: root }
  });

  try {
    const window = await desktop.firstWindow();
    await expect(window.getByText('Watching state files', { exact: true })).toBeVisible();
    await expect(window.getByText('Demo data')).toHaveCount(0);
    await expect(window.getByLabel('Orquesta Map')).toBeVisible();
    await expect(window.locator('[data-node-kind="agent"]')).toHaveCount(2);
    await expect(window.getByRole('button', { name: 'Builder, Working' })).toBeVisible();
    await expect(window.getByText('Approve integration result?')).toBeVisible();

    const agentsDocument = JSON.parse(await readFile(agentsPath, 'utf8')) as { agents: unknown[] };
    agentsDocument.agents.push({
      agent_id: 'reviewer', role: 'review', display_name: 'Reviewer', status: 'standby', current_task: null,
      assigned_by_agent_id: 'orchestrator', mission: 'Review the result.'
    });
    await writeFile(agentsPath, `${JSON.stringify(agentsDocument, null, 2)}\n`, 'utf8');
    await expect(window.locator('[data-node-kind="agent"]')).toHaveCount(3);
    await expect(window.getByRole('button', { name: 'Reviewer, Idle' })).toBeVisible();

    expect(await readFile(tasksPath, 'utf8')).toBe(originalTasks);
    expect((await readFile(agentsPath, 'utf8')).includes('Reviewer')).toBe(true);
  } finally {
    await desktop.close();
    await Promise.all([rm(root, { recursive: true, force: true }), rm(userData, { recursive: true, force: true })]);
  }
});

test('shows a bounded first-launch project chooser instead of prototype content', async () => {
  const userData = await mkdtemp(path.join(os.tmpdir(), 'orquesta-electron-first-run-'));
  const desktop = await electron.launch({
    args: [`--user-data-dir=${userData}`, '--lang=en-US', '.'],
    cwd: appRoot,
    env: { ...process.env, ORQUESTA_E2E: '1' }
  });

  try {
    const window = await desktop.firstWindow();
    await expect(window.getByRole('heading', { name: 'Open your first Orquesta project' })).toBeVisible();
    await expect(window.getByRole('button', { name: 'Open project folder' })).toBeVisible();
    await expect(window.getByText('Demo data')).toHaveCount(0);
    await expect(window.getByLabel('Orquesta Map')).toHaveCount(0);
  } finally {
    await desktop.close();
    await rm(userData, { recursive: true, force: true });
  }
});
