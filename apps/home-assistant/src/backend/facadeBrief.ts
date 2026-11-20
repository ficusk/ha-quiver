// The brief behind the `facadeGuide` tool: how to build a *facade*, a Quiver
// app that is only UI and drives this app through cross-app calls. Lamp
// (apps/lamp) is one.
//
// The tool list is read live from the platform's view of this app's
// manifest, so the brief can't drift from what the app actually exposes.
// Pure function; facadeBrief.test.ts pins the shape.

export interface FacadeToolInfo {
  name: string;
  kind: "query" | "mutation" | "action";
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
}

export interface FacadeBriefInput {
  appId: string;
  displayName: string;
  tools: FacadeToolInfo[];
  /** What the member asked for, if the agent passed it along. */
  goal?: string;
}

// Reads first: a facade wires up state before controls.
const KIND_ORDER: Record<FacadeToolInfo["kind"], number> = {
  query: 0,
  mutation: 1,
  action: 2,
};

const HOOK: Record<FacadeToolInfo["kind"], string> = {
  query: "useQuery",
  mutation: "useMutation",
  action: "useAction",
};

function schemaBlock(schema: unknown): string | null {
  if (schema === undefined || schema === null) return null;
  return "```json\n" + JSON.stringify(schema, null, 2) + "\n```";
}

function toolSection(t: FacadeToolInfo): string {
  const lines = [`### \`${t.name}\` (${t.kind}, via \`${HOOK[t.kind]}\`)`];
  if (t.description?.trim()) lines.push("", t.description.trim());
  const args = schemaBlock(t.inputSchema);
  lines.push("", args ? `Args:\n${args}` : "Takes no args.");
  const result = schemaBlock(t.outputSchema);
  if (result) lines.push("", `Returns:\n${result}`);
  return lines.join("\n");
}

export function buildFacadeBrief(input: FacadeBriefInput): string {
  const { appId, displayName } = input;
  const tools = [...input.tools].sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name),
  );
  const goal = input.goal?.trim();

  return `# Building a custom UI over ${displayName}

A *facade* is a Quiver app that is nothing but UI. It has no backend and no
tables; it reads and controls the home through the \`${appId}\` app installed
in the same channel. Installing both apps in one channel is the whole
authorization, and the facade's manifest declares nothing about it.

## Shape

Two files.

\`quiver.app.ts\`:

\`\`\`ts
import type { AppManifest } from "@quiver/system";

const manifest: AppManifest = {
  displayName: "Porch Lights",
  summary: "One-tap control of the porch and driveway lights.",
  categories: ["home"],
  entrypoints: { channel: "src/app.tsx" },
};

export default manifest;
\`\`\`

\`src/app.tsx\`:

\`\`\`tsx
import { useApp, useAppContext } from "@quiver/react";

export default function App() {
  const ctx = useAppContext();
  const home = useApp("${appId}");
  // Hooks first, unconditionally and in a stable order. useQuery returns
  // undefined until data arrives, and stays undefined while ${appId}
  // isn't installed here.
  const entities = home.useQuery<Entity[]>("entities");
  const connection = home.useQuery<Connection | null>("connection");
  const callService = home.useAction("callService");

  if (!ctx) return null;
  if (!home.isInstalled) {
    return <p>Add the ${displayName} app to this channel first.</p>;
  }
  // ...
}
\`\`\`

## Rules

- Read state from queries. They're reactive, so the UI updates on its own when
  the home reports a change. Control calls resolve before the home has acted,
  so never read state back from one.
- Show the user's intent immediately (a toggle flips on tap) and let the
  \`entities\` query settle it a moment later.
- When \`connection\` says the home is offline, say so and keep showing the
  last-known state; control calls will fail until it's back.
- Don't pass \`channelId\` or \`caller\`. The platform fills them in.
- \`quiver docs cross-app\` has the full \`useApp\` API.

## What ${displayName} exposes

${tools.length > 0 ? tools.map(toolSection).join("\n\n") : "_No tools were found. Is the app installed in this channel?_"}

## The task

${
  goal
    ? `The member asked for: ${goal}`
    : "Ask the member what they want this UI to do if they haven't said: which devices, and what it should feel like."
}

Look up entity ids in \`entities\` rather than guessing them; label things
with \`attributes.friendly_name\`. Check the result with \`quiver check\`.
`;
}
