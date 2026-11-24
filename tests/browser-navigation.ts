import type { Page } from "playwright";
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
