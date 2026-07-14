/** @format */

"use strict";

const puppeteer = require("puppeteer");

const PDF_WIDTH_PX = 1200;
const PDF_HEIGHT_PX = 820;
const MAX_QUEUED_JOBS = 3;
const MAX_QUEUE_WAIT_MS = 60_000;
const OPERATION_TIMEOUT_MS = 25_000;
const RENDER_TIMEOUT_MS = 45_000;
const MAX_PDF_BYTES = 5 * 1024 * 1024;

class GuestCardPdfBusyError extends Error {
  constructor(message = "Guest Card PDF generation is busy.") {
    super(message);
    this.name = "GuestCardPdfBusyError";
    this.code = "GUEST_CARD_PDF_BUSY";
  }
}

const withTimeout = (promise, timeoutMs, message) => {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error(message);
      error.code = "GUEST_CARD_PDF_TIMEOUT";
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() =>
    clearTimeout(timeoutId)
  );
};

class SerializedGuestCardPdfQueue {
  constructor({
    maxQueued = MAX_QUEUED_JOBS,
    maxWaitMs = MAX_QUEUE_WAIT_MS,
  } = {}) {
    this.active = false;
    this.items = [];
    this.maxQueued = maxQueued;
    this.maxWaitMs = maxWaitMs;
  }

  run(task) {
    if (typeof task !== "function") {
      return Promise.reject(
        new TypeError("A PDF generation task is required.")
      );
    }
    if (this.active && this.items.length >= this.maxQueued) {
      return Promise.reject(new GuestCardPdfBusyError());
    }
    return new Promise((resolve, reject) => {
      const item = { task, resolve, reject, timeoutId: null };
      if (this.active) {
        item.timeoutId = setTimeout(() => {
          const index = this.items.indexOf(item);
          if (index >= 0) this.items.splice(index, 1);
          reject(new GuestCardPdfBusyError("Guest Card PDF queue timed out."));
        }, this.maxWaitMs);
      }
      this.items.push(item);
      this.drain();
    });
  }

  async drain() {
    if (this.active) return;
    const item = this.items.shift();
    if (!item) return;
    this.active = true;
    clearTimeout(item.timeoutId);
    try {
      item.resolve(await item.task());
    } catch (error) {
      item.reject(error);
    } finally {
      this.active = false;
      queueMicrotask(() => this.drain());
    }
  }

  getStats() {
    return { active: this.active ? 1 : 0, queued: this.items.length };
  }
}

const queue = new SerializedGuestCardPdfQueue();

const closeQuietly = async (resource) => {
  if (!resource || typeof resource.close !== "function") return;
  try {
    await withTimeout(
      Promise.resolve(resource.close()),
      5_000,
      "Timed out while closing PDF resources."
    );
  } catch (_error) {
    // Cleanup errors must not hide the original generation result.
  }
};

const renderPdf = async (html) => {
  if (typeof html !== "string" || !html.trim() || html.length > 500_000) {
    throw new Error("A valid Guest Card document is required.");
  }
  let browser = null;
  let page = null;
  const renderDeadline = Date.now() + RENDER_TIMEOUT_MS;
  const withinRenderDeadline = (promise, message) =>
    withTimeout(
      promise,
      Math.max(1, Math.min(OPERATION_TIMEOUT_MS, renderDeadline - Date.now())),
      message
    );
  const launchPromise = puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-zygote",
    ],
  });
  try {
    browser = await withinRenderDeadline(
      launchPromise,
      "Timed out while starting the PDF renderer."
    );
    page = await withinRenderDeadline(
      browser.newPage(),
      "Timed out while opening the PDF page."
    );
    page.setDefaultTimeout(OPERATION_TIMEOUT_MS);
    await withinRenderDeadline(
      page.setRequestInterception(true),
      "Timed out while securing the Guest Card renderer."
    );
    page.on("request", (request) => {
      const url = request.url();
      const action =
        url === "about:blank" || url.startsWith("data:")
          ? request.continue()
          : request.abort();
      Promise.resolve(action).catch(() => {});
    });
    await withinRenderDeadline(
      page.setContent(html, { waitUntil: "domcontentloaded" }),
      "Timed out while rendering the Guest Card."
    );
    await withinRenderDeadline(
      page.evaluate(async () => {
        if (document.fonts?.ready) await document.fonts.ready;
      }),
      "Timed out while loading the Guest Card fonts."
    );
    const output = await withinRenderDeadline(
      page.pdf({
        width: `${PDF_WIDTH_PX}px`,
        height: `${PDF_HEIGHT_PX}px`,
        printBackground: true,
        margin: { top: 0, right: 0, bottom: 0, left: 0 },
        preferCSSPageSize: true,
      }),
      "Timed out while creating the Guest Card PDF."
    );
    const pdf = Buffer.from(output);
    if (!pdf.length || pdf.length > MAX_PDF_BYTES) {
      const error = new Error(
        "The generated Guest Card PDF has an invalid size."
      );
      error.code = "GUEST_CARD_PDF_SIZE";
      throw error;
    }
    return pdf;
  } finally {
    if (!browser) {
      launchPromise.then(closeQuietly).catch(() => {});
    }
    await closeQuietly(page);
    await closeQuietly(browser);
  }
};

const generateGuestCardPdf = (html) => queue.run(() => renderPdf(html));

module.exports = {
  GuestCardPdfBusyError,
  MAX_PDF_BYTES,
  SerializedGuestCardPdfQueue,
  generateGuestCardPdf,
  getGuestCardPdfQueueStats: () => queue.getStats(),
  renderPdf,
};
