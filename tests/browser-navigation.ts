import assert from "node:assert/strict";
import type { APIResponse, Page } from "playwright";
import { adminPaths } from "../packages/contracts/admin-paths";

export async function openAdmin(page: Page, view: keyof typeof adminPaths) {
  const previous = new URL(page.url());
  const target = new URL(adminPaths[view], previous);
  if (view === "logs" || view === "inspector") {
    const thread = await page.evaluate((testChat) => localStorage.getItem(testChat
      ? "pzn-active-admin-conversation" : "pzn-active-conversation"), previous.pathname === adminPaths.chat);
    if (thread) target.searchParams.set("thread", thread);
  }
  await page.goto(target.href);
}

export async function openCustomerChat(page: Page) {
  await page.getByRole("link", { name: "Customer view", exact: true }).click();
}

export async function approvePublicationInChat(page: Page, previewTitle?: string) {
  const prior = await page.evaluate(() => localStorage.getItem("pzn-active-admin-conversation"));
  const popup = page.waitForEvent("popup");
  await page.getByRole("link", { name: "Review in Admin chat", exact: true }).click();
  const review = await popup;
  try {
    if (previewTitle) {
      await review.getByText("Review prepared change", { exact: true }).click();
      await review.getByRole("heading", { name: previewTitle, exact: true }).waitFor();
    }
    await review.getByRole("button", { name: "Approve publication", exact: true }).click();
    await review.getByText("Approved & Executed", { exact: true }).waitFor();
  } finally {
    await review.close();
  }
  if (prior) await page.evaluate((thread) => localStorage.setItem("pzn-active-admin-conversation", thread), prior);
  const dismiss = page.getByRole("status", { name: "Publication review requested" }).getByRole("button", { name: "Dismiss" });
  if (await dismiss.isVisible()) await dismiss.click();
}

export async function approvePublicationResponse(page: Page, response: APIResponse) {
  assert.equal(response.status(), 202);
  const { approval } = await response.json();
  const result = await page.request.post(new URL("/api/approvals/" + approval.id + "/decide", response.url()).href, {
    data: { decision: "approve" },
  });
  assert.equal(result.status(), 200, await result.text());
  assert.equal((await result.json()).approval.status, "executed");
}
