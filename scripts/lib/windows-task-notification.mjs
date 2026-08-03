import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { startManagedProcess } from '../../shared/execution-kernel.mjs';

const codexProRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const defaultNotificationScript = path.join(codexProRoot, 'scripts', 'notifications', 'notify-task-finished.sh');

function expandHome(input) {
  const value = String(input || '').trim();
  if (!value || value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function limitText(value, maxLength) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function taskNameFromPlan(planText, fallback = 'CodexPro 任务') {
  const lines = String(planText || '').split(/\r?\n/);
  const heading = lines
    .map((line) => line.match(/^\s*#{1,6}\s+(.+?)\s*$/)?.[1])
    .find(Boolean);
  return limitText(heading || fallback, 160) || 'CodexPro 任务';
}

export function buildWindowsTaskCompletionNotification(options = {}) {
  const env = options.env ?? process.env;
  const root = path.resolve(String(options.root || process.cwd()));
  const projectName = limitText(options.projectName || path.basename(root) || 'codexpro-project', 100);
  const scriptPath = path.resolve(expandHome(options.scriptPath || defaultNotificationScript));

  if (!fs.existsSync(scriptPath)) {
    return {
      enabled: false,
      reason: 'notification_script_missing',
      scriptPath
    };
  }

  const agent = limitText(options.agent || 'codex', 80);
  const taskName = taskNameFromPlan(options.planText, `${projectName} 任务`);
  const result = limitText(`任务已成功完成，执行代理 ${agent} 正常退出。`, 500);
  const nextStep = '回到 ChatGPT 查看结果。';

  return {
    enabled: true,
    reason: 'ready',
    command: 'bash',
    args: [scriptPath, taskName, result, nextStep, projectName],
    cwd: codexProRoot,
    env: {
      ...env,
      CODEXPRO_TARGET_ROOT: root,
      CODEXPRO_PROJECT_ROOT: root,
      CODEXPRO_PROJECT_NAME: projectName
    },
    scriptPath,
    projectName,
    taskName
  };
}

export function dispatchWindowsTaskCompletionNotification(options = {}) {
  const notification = buildWindowsTaskCompletionNotification(options);
  if (!notification.enabled) {
    return {
      queued: false,
      reason: notification.reason,
      scriptPath: notification.scriptPath
    };
  }

  try {
    const child = options.spawnImpl
      ? options.spawnImpl(notification.command, notification.args, {
          cwd: notification.cwd,
          env: notification.env,
          detached: true,
          stdio: 'ignore',
          windowsHide: true
        })
      : startManagedProcess(notification.command, notification.args, {
          cwd: notification.cwd,
          env: notification.env,
          detached: true,
          stdio: 'ignore',
          domain: 'notification',
          operation: 'windows_task_completion_notification',
          sideEffectLevel: 'external_write',
          riskLevel: 'low',
          recordRoot: options.root || process.cwd()
        }).child;
    if (!child || typeof child.unref !== 'function') {
      return {
        queued: false,
        reason: 'notification_process_not_started',
        scriptPath: notification.scriptPath
      };
    }
    if (typeof child.on === 'function') child.on('error', () => {});
    child.unref();
    return {
      queued: true,
      reason: 'notification_process_started',
      scriptPath: notification.scriptPath,
      projectName: notification.projectName,
      taskName: notification.taskName
    };
  } catch (error) {
    return {
      queued: false,
      reason: 'notification_spawn_failed',
      error: error instanceof Error ? error.message : String(error),
      scriptPath: notification.scriptPath
    };
  }
}
