import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import type { BackgroundRequest } from "@/lib/messages.js";
import * as sync from "@/lib/sync.js";

const CONTEXT_MENU_LINK = "neo-check-link";
const CONTEXT_MENU_PAGE = "neo-check-page";

function openCheckWindow(url: string): void {
  const target = browser.runtime.getURL(`/popup.html?check=${encodeURIComponent(url)}`);
  void browser.windows.create({ url: target, type: "popup", width: 380, height: 560 });
}

async function createContextMenus(): Promise<void> {
  await browser.contextMenus.removeAll();
  browser.contextMenus.create({ id: CONTEXT_MENU_LINK, title: "Check this link with Neo", contexts: ["link"] });
  browser.contextMenus.create({ id: CONTEXT_MENU_PAGE, title: "Check this page with Neo", contexts: ["page"] });
}

/** The message router. Exported so `test/background.test.ts` can call it without going through `defineBackground`. */
export async function handleMessage(message: BackgroundRequest, sender: { tab?: { id?: number } }): Promise<unknown> {
  const tabId = sender.tab?.id;
  switch (message.type) {
    case "tech-support-hit":
      await sync.reportTechSupportHit({ domain: message.domain, pageUrl: message.pageUrl, indicators: message.indicators, phone: message.phone }, tabId);
      return { ok: true };
    case "lookalike-hit":
      await sync.reportLookalikeHit({ domain: message.domain, pageUrl: message.pageUrl, brand: message.brand, indicators: message.indicators }, tabId);
      return { ok: true };
    case "warning-bypassed":
      if (tabId !== undefined) await sync.reportWarningBypassed(message.relatesTo, message.domain, message.originalUrl, tabId);
      return { ok: true };
    case "get-state":
      return sync.getStateForClient();
    case "preview-code":
      return sync.previewCode(message.code);
    case "enroll-with-code":
      return sync.enrollWithCode(message.code, message.deviceName);
    case "start-sign-in":
      return sync.startSignIn(message.deviceName);
    case "poll-sign-in":
      return sync.pollSignIn();
    case "cancel-sign-in":
      await sync.cancelSignIn();
      return { ok: true };
    case "stop-protecting":
      await sync.stopProtecting();
      return { ok: true };
    case "set-server-url":
      return sync.setServerUrl(message.url);
    case "request-host-permission":
      return browser.permissions.request({ origins: ["<all_urls>"] });
    case "check-url":
      return sync.checkUrlOnDemand(message.url);
    default:
      return { ok: false, error: "unknown_message" };
  }
}

export default defineBackground(() => {
  browser.runtime.onInstalled.addListener(() => {
    createContextMenus();
    void sync.init();
  });
  browser.runtime.onStartup.addListener(() => {
    void sync.init();
  });

  browser.alarms.onAlarm.addListener((alarm) => {
    void sync.handleAlarm(alarm.name);
  });

  browser.downloads.onCreated.addListener((download) => {
    void sync.handleDownloadCreated({ id: download.id, filename: download.filename, url: download.url, referrer: download.referrer });
  });

  browser.contextMenus.onClicked.addListener((info) => {
    const url = info.menuItemId === CONTEXT_MENU_LINK ? info.linkUrl : info.pageUrl;
    if (url) openCheckWindow(url);
  });

  browser.runtime.onMessage.addListener((message, sender) => handleMessage(message as BackgroundRequest, sender));
});
