// Standalone @sfield/core + @sfield/preset-memory quickstart
import { SField, defineTool } from "@sfield/core";

const greet = defineTool({
  id: "demo.greet",
  version: "1.0.0",
  description: "Greet a user by name.",
  inputs: {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
    additionalProperties: false,
  },
  outputs: {
    type: "object",
    properties: { greeting: { type: "string" } },
    required: ["greeting"],
    additionalProperties: false,
  },
  policy: { effect: "read", classification: "public" },
  handler: async ({ name }) => ({ greeting: `Hello from sfield, ${name}!` }),
});

const sf = await SField.create({
  config: { version: 1, models: {}, agents: {} },
  preset: "memory",
  tools: [greet],
  quiet: true,
});

const result = await sf.registry.execute({
  toolRef: "demo.greet@1.0.0",
  inputs: { name: "Ada" },
});
console.log("Tool result:", result.status, result.output);
await sf.close();
