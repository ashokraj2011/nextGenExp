import { randomBytes } from "node:crypto";
import { startApp as startServer } from "../apps/server/http";

export const author = { username: "Author A", password: randomBytes(24).toString("hex") };
export const reviewer = { username: "On-call Lead", password: randomBytes(24).toString("hex") };
export const operatorHeader = (user = author) => "Basic " + Buffer.from(user.username + ":" + user.password).toString("base64");
export const testOperators = { [author.username]: author.password, [reviewer.username]: reviewer.password };
export function startApp(options: Parameters<typeof startServer>[0]) {
  return startServer({ ...options, operators: testOperators });
}
