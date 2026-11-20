import { describe, expect, test } from "bun:test";
import { buildFacadeBrief } from "./facadeBrief";

describe("buildFacadeBrief", () => {
  const brief = buildFacadeBrief({
    appId: "home-assistant",
    displayName: "Home Assistant",
    tools: [
      {
        name: "callService",
        kind: "action",
        description: "Call a service.",
        inputSchema: { type: "object" },
      },
      { name: "entities", kind: "query", description: "All entities." },
    ],
  });

  test("lists queries before actions, with the hook to call each", () => {
    const q = brief.indexOf("### `entities` (query, via `useQuery`)");
    const a = brief.indexOf("### `callService` (action, via `useAction`)");
    expect(q).toBeGreaterThan(-1);
    expect(a).toBeGreaterThan(q);
  });

  test("uses the app id it was given", () => {
    expect(brief).toContain('useApp("home-assistant")');
  });

  test("uses the current entrypoint spelling", () => {
    expect(brief).toContain('entrypoints: { channel: "src/app.tsx" }');
    expect(brief).not.toContain("main:");
  });

  test("carries the member's goal through when given", () => {
    const withGoal = buildFacadeBrief({
      appId: "home-assistant",
      displayName: "Home Assistant",
      tools: [],
      goal: "a doorbell panel",
    });
    expect(withGoal).toContain("The member asked for: a doorbell panel");
    expect(brief).toContain("Ask the member what they want");
  });
});
