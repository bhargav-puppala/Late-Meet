import test from "node:test";
import assert from "node:assert/strict";

import { getMeetingIdFromUrl, resolveManualMeetTab } from "./meetingTabs.ts";

type MockTab = Pick<chrome.tabs.Tab, "id" | "url" | "active"> & {
  currentWindow?: boolean;
};

function mockChromeTabs(tabs: MockTab[]) {
  const previousChrome = (globalThis as any).chrome;

  (globalThis as any).chrome = {
    tabs: {
      query: async (queryInfo: chrome.tabs.QueryInfo) => {
        if (queryInfo.active && queryInfo.currentWindow) {
          return tabs.filter((tab) => tab.active && tab.currentWindow) as chrome.tabs.Tab[];
        }

        if (queryInfo.url === "https://meet.google.com/*") {
          return tabs.filter((tab) =>
            tab.url?.startsWith("https://meet.google.com/"),
          ) as chrome.tabs.Tab[];
        }

        return [];
      },
    },
  };

  return () => {
    (globalThis as any).chrome = previousChrome;
  };
}

test("meeting id extraction accepts real Meet rooms and rejects non-room URLs", () => {
  assert.equal(getMeetingIdFromUrl("https://meet.google.com/abc-defg-hij"), "abc-defg-hij");
  assert.equal(getMeetingIdFromUrl("https://meet.google.com/new"), null);
  assert.equal(getMeetingIdFromUrl("https://example.com/abc-defg-hij"), null);
  assert.equal(getMeetingIdFromUrl(undefined), null);
});

test("manual Meet tab resolution prefers the active meeting tab", async () => {
  const cleanup = mockChromeTabs([
    {
      id: 1,
      url: "https://meet.google.com/old-room-aaa",
      active: false,
      currentWindow: true,
    },
    {
      id: 2,
      url: "https://meet.google.com/live-room-bbb",
      active: true,
      currentWindow: true,
    },
  ]);

  try {
    const selected = await resolveManualMeetTab();
    assert.equal(selected.tab.id, 2);
    assert.equal(selected.meetingId, "live-room-bbb");
  } finally {
    cleanup();
  }
});

test("manual Meet tab resolution falls back when exactly one meeting tab is open", async () => {
  const cleanup = mockChromeTabs([
    {
      id: 3,
      url: "https://example.com/",
      active: true,
      currentWindow: true,
    },
    {
      id: 4,
      url: "https://meet.google.com/only-room-ccc",
      active: false,
      currentWindow: true,
    },
  ]);

  try {
    const selected = await resolveManualMeetTab();
    assert.equal(selected.tab.id, 4);
    assert.equal(selected.meetingUrl, "https://meet.google.com/only-room-ccc");
  } finally {
    cleanup();
  }
});

test("manual Meet tab resolution rejects ambiguous background meetings", async () => {
  const cleanup = mockChromeTabs([
    {
      id: 5,
      url: "https://example.com/",
      active: true,
      currentWindow: true,
    },
    {
      id: 6,
      url: "https://meet.google.com/first-room-ddd",
      active: false,
      currentWindow: true,
    },
    {
      id: 7,
      url: "https://meet.google.com/second-room-eee",
      active: false,
      currentWindow: false,
    },
  ]);

  try {
    await assert.rejects(resolveManualMeetTab(), /Multiple Meet tabs/);
  } finally {
    cleanup();
  }
});
