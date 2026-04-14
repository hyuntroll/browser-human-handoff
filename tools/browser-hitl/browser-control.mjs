#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const baseDir =
  process.env.OPENCLAW_HITL_BASE_DIR ??
  path.join(process.env.HOME ?? "", ".openclaw-hitl");

const [sessionId, action, ...args] = process.argv.slice(2);

if (!sessionId || !action) {
  console.error(
    "usage: node tools/browser-hitl/browser-control.mjs <session_id> <action> [args...]",
  );
  process.exit(1);
}

const sessionDir = path.join(baseDir, sessionId);
const metadataPath = path.join(sessionDir, "session.json");

function nowEpoch() {
  return Math.floor(Date.now() / 1000);
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function loadMetadata() {
  if (!(await fileExists(metadataPath))) {
    throw new Error(`session metadata not found: ${sessionId}`);
  }

  const raw = await fs.readFile(metadataPath, "utf8");
  return JSON.parse(raw);
}

async function writeMetadata(metadata) {
  await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

async function updateMetadata(mutator) {
  const metadata = await loadMetadata();
  mutator(metadata);
  await writeMetadata(metadata);
  return metadata;
}

async function ensureArtifactsDir() {
  const artifactsDir = path.join(sessionDir, "artifacts");
  await fs.mkdir(artifactsDir, { recursive: true });
  return artifactsDir;
}

function requireArg(index, label) {
  const value = args[index];
  if (!value) {
    throw new Error(`${label} is required for the ${action} action`);
  }
  return value;
}

async function connectWithRetry(chromium, cdpUrl) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await chromium.connectOverCDP(cdpUrl);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError;
}

async function loadPlaywrightChromium() {
  try {
    return await import("playwright-core");
  } catch (coreError) {
    try {
      return await import("playwright");
    } catch (playwrightError) {
      throw new Error(
        `playwright-core (or playwright) is required to control the handoff browser: ${playwrightError.message}`,
      );
    }
  }
}

function assertSessionReusable(metadata) {
  if (!metadata.cdp_url) {
    throw new Error("cdp_url is missing from session metadata");
  }

  if (metadata.expires_at && nowEpoch() >= metadata.expires_at) {
    throw new Error("handoff session has expired");
  }

  if (["CLOSED", "EXPIRED", "FAILED"].includes(metadata.status)) {
    throw new Error(`handoff session is not reusable: ${metadata.status}`);
  }
}

function activePageFrom(browser) {
  const contexts = browser.contexts();
  if (contexts.length === 0) {
    throw new Error("no browser context is available for this session");
  }

  const context = contexts[0];
  const pages = context.pages();
  if (pages.length === 0) {
    throw new Error("no browser page is available for this session");
  }

  return pages[pages.length - 1];
}

async function main() {
  let browser;
  let page;
  let metadata = await loadMetadata();

  assertSessionReusable(metadata);

  if (metadata.status === "WAITING_FOR_USER") {
    metadata.status = "RESUMABLE";
    metadata.last_action = "user_completed";
    await writeMetadata(metadata);
  }

  let chromium;
  try {
    ({ chromium } = await loadPlaywrightChromium());
  } catch (error) {
    throw error;
  }

  try {
    browser = await connectWithRetry(chromium, metadata.cdp_url);
  } catch (error) {
    await updateMetadata((current) => {
      current.status = "FAILED";
      current.closed_reason = "cdp_connect_failed";
      current.last_action = "cdp_connect_failed";
    });
    throw error;
  }

  try {
    page = activePageFrom(browser);
    page.setDefaultTimeout(10000);

    metadata = await updateMetadata((current) => {
      current.status = "RESUMED";
      current.last_action = action;
      current.last_url = page.url();
    });

    let output;
    switch (action) {
      case "url":
        output = { value: page.url() };
        break;
      case "title":
        output = { value: await page.title() };
        break;
      case "goto": {
        const targetUrl = requireArg(0, "target URL");
        await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
        output = { value: page.url() };
        break;
      }
      case "screenshot": {
        const artifactsDir = await ensureArtifactsDir();
        const targetPath =
          args[0] ?? path.join(artifactsDir, `screenshot-${Date.now()}.png`);
        await page.screenshot({ path: targetPath, fullPage: true });
        output = { path: targetPath };
        metadata = await updateMetadata((current) => {
          current.last_screenshot = targetPath;
          current.last_url = page.url();
          current.last_action = "screenshot";
        });
        break;
      }
      case "click": {
        const selector = requireArg(0, "selector");
        await page.click(selector);
        output = { selector };
        break;
      }
      case "fill": {
        const selector = requireArg(0, "selector");
        const value = requireArg(1, "value");
        await page.fill(selector, value);
        output = { selector, filled: true };
        break;
      }
      case "press": {
        const key = requireArg(0, "key");
        await page.keyboard.press(key);
        output = { key };
        break;
      }
      case "content":
        output = { value: await page.content() };
        break;
      default:
        throw new Error(`unsupported action: ${action}`);
    }

    metadata = await updateMetadata((current) => {
      current.status = "RESUMED";
      current.last_action = action;
      current.last_url = page.url();
    });

    console.log(
      JSON.stringify(
        {
          session_id: sessionId,
          action,
          status: metadata.status,
          ...output,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    let errorScreenshot = null;

    if (page) {
      try {
        const artifactsDir = await ensureArtifactsDir();
        errorScreenshot = path.join(artifactsDir, `error-${Date.now()}.png`);
        await page.screenshot({ path: errorScreenshot, fullPage: true });
      } catch {
        errorScreenshot = null;
      }
    }

    await updateMetadata((current) => {
      current.last_action = `${action}_failed`;
      current.last_url = page ? page.url() : current.last_url;
      if (errorScreenshot) {
        current.last_screenshot = errorScreenshot;
      }
    });

    throw error;
  } finally {
    await browser?.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
