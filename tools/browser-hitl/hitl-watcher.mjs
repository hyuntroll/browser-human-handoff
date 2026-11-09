#!/usr/bin/env node

import process from "node:process";
import {
  CliError,
  TERMINAL_STATUSES,
  getSessionPaths,
  loadSession,
  logEvent,
  mainError,
  nowEpoch,
  pidAlive,
  releaseAgentLock,
  sleep,
  terminatePid,
  updateSession,
} from "./hitl-lib.mjs";

async function expireSession(sessionId, gatewayPid) {
  if (gatewayPid) await terminatePid(gatewayPid, 3000).catch(() => {});
  await updateSession(sessionId, (session) => {
    session.share_active = false;
    if (session.status === "WAITING_FOR_USER") {
      session.status = "EXPIRED";
      session.closed_at = nowEpoch();
      session.closed_reason = "ttl_expired";
      session.last_action = "expired";
    }
  });
  await releaseAgentLock(sessionId);
}

async function main() {
  const [sessionId] = process.argv.slice(2);
  if (!sessionId || process.argv.length !== 3) {
    throw new CliError("usage: hitl-watcher.mjs <session_id>", 64);
  }
  const paths = getSessionPaths(sessionId);
  await loadSession(sessionId);
  await logEvent(paths.watcherLog, "watcher_started");
  let reportedGatewayDeath = false;

  for (;;) {
    const session = await loadSession(sessionId);
    if (
      TERMINAL_STATUSES.has(session.status) ||
      session.done_at ||
      session.status === "RESUMABLE" ||
      session.status === "RESUMED"
    ) {
      await logEvent(paths.watcherLog, "watcher_stopped");
      return;
    }

    if (nowEpoch() >= session.expires_at) {
      await expireSession(sessionId, session.gateway?.pid);
      await logEvent(paths.watcherLog, "expired");
      return;
    }

    if (session.share_active && !pidAlive(session.gateway?.pid)) {
      await updateSession(sessionId, (current) => {
        current.share_active = false;
      });
      if (!reportedGatewayDeath) {
        await logEvent(paths.watcherLog, "gateway_died");
        reportedGatewayDeath = true;
      }
    }

    await sleep(1000);
  }
}

main().catch(mainError);
