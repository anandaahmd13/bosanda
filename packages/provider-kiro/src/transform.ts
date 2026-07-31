/**
 * CanonicalRequest -> Kiro request (PLAN.md §6 "Request transformation
 * invariants", §3 G1, §16).
 *
 * The shape below is the version-1 GUESS at `conversationState`, reconstructed
 * from the reference architecture described in §2. It is NOT a verified
 * contract: §3 G1 exists precisely to freeze the real shape against live
 * traffic, and M0 has not been executed. `FIXTURE_VERSION` is what a usage row
 * records (§3 "Compatibility versioning"), so a shape change is a version bump
 * and a compatibility-suite rerun, never a silent edit.
 *
 * Four invariants are enforced here rather than documented, because each one is
 * a security property:
 *
 *  1. A FRESH conversation ID per call (§6, §16 privacy). Hidden context is
 *     never shared between requests or between customers. The ID is generated
 *     inside this function and not accepted as a parameter — a caller cannot
 *     pass a stale one even by mistake.
 *  2. NO injected tools. Only tools the CLIENT declared are forwarded, and
 *     `assertNoInjectedTools` verifies the outbound set against the declared set
 *     rather than against a blocklist of names. §6's rule constrains what BOSANDA
 *     adds, not what a customer asks for: a client is entitled to declare `Bash`
 *     or `Read` and execute it on its own machine, which is exactly the Claude
 *     Code loop §3 G3 requires. Tools execute client-side only (§3 G3 "no
 *     server-side tool execution").
 *  3. NO Bosanda secrets, paths, or environment variables in the prompt. The
 *     system prompt is passed through from the client verbatim and nothing is
 *     prepended; there is no template into which an env var could be
 *     interpolated. `assertNoServerContext` is the belt-and-braces check.
 *  4. Deterministic history repair. Consecutive same-role messages are MERGED
 *     (not rejected) because Anthropic clients legitimately split tool results
 *     across messages, and an empty history is rejected.
 */

import { BosandaError, type CanonicalContent, type CanonicalRequest } from "@bosanda/protocol";
import type { Persona } from "@bosanda/provider-core";
import { conversationId } from "@bosanda/shared";

/**
 * Upstream protocol fixture version (§3 "Compatibility versioning"). The `-draft`
 * suffix is load-bearing: it records that this shape has never been validated
 * against live upstream traffic.
 */
export const FIXTURE_VERSION = "kiro-conversation-state-1-draft";

/**
 * Tool names that imply a HOST capability — a filesystem, a shell, an MCP
 * server, or the process environment (§6, §16, §3 G3).
 *
 * READ THIS BEFORE USING THE LIST. It classifies names; it does NOT gate client
 * requests. §6's rule is "never INJECT filesystem, shell, MCP, or
 * host-environment tools" — a constraint on what BOSANDA adds, not on what a
 * customer declares. A client is entitled to declare a tool called `Bash` and
 * run it on its own machine: that is precisely the Claude Code loop §3 G3
 * requires to work, and tools execute client-side only.
 *
 * An earlier revision used this list to REJECT client-declared tools. That made
 * `unsupported_capability` the response to Claude Code's primary tool (named
 * exactly `Bash`), along with `shell`, `exec`, `run_command`, and `env`, so G3
 * ("Complete Claude Code client-side tool use passes", "valid Claude Code
 * behavior on a real repository") could not have passed — and §3 makes a G3
 * failure a no-go for the whole project. The check was strictly harmful: it
 * blocked legitimate traffic while providing no protection, because a client
 * declaring a tool cannot make the SERVER execute it.
 *
 * The real invariant is enforced structurally by `assertNoInjectedTools`, which
 * compares what goes upstream against what the client sent.
 */
const HOST_CAPABILITY_PATTERNS: readonly RegExp[] = [
  /^fs[_.]/i,
  /^file[_.]?system/i,
  /^(read|write|edit|multi_?edit)_?file$/i,
  /^(shell|bash|sh|zsh|powershell|cmd|exec|spawn|subprocess)$/i,
  /^(execute|run)_?(command|shell|bash|code)$/i,
  /^mcp[_.]/i,
  /^host[_.]/i,
  /^(env|environment|getenv)$/i,
  /^bosanda[_.]/i,
];

/** Env-var and path shapes that must never appear in an outbound prompt (§16). */
const SERVER_CONTEXT_PATTERNS: readonly { pattern: RegExp; what: string }[] = [
  { pattern: /\bBOSANDA_[A-Z0-9_]+\b/, what: "a BOSANDA_* environment variable name" },
  {
    pattern: /\b(?:PROVIDER|API_KEY|SESSION|PAKASIR)_[A-Z0-9_]*(?:KEY|SECRET)\b/,
    what: "a Bosanda secret variable name",
  },
  { pattern: /\bbsk_[0-9A-HJKMNP-TV-Z]{8,}/, what: "a Bosanda API key" },
  { pattern: /\barn:aws:[a-z0-9-]*:[a-z0-9-]*:\d{12}:/, what: "an AWS account ARN" },
  { pattern: /\/(?:etc|srv|opt)\/bosanda\b/, what: "a Bosanda deployment path" },
];

export type KiroToolSpecification = {
  toolSpecification: {
    name: string;
    description: string;
    inputSchema: { json: Record<string, unknown> };
  };
};

export type KiroUserInputMessage = {
  content: string;
  userInputMessageContext: {
    /** Tools the CLIENT declared. Empty array when the client declared none. */
    tools?: KiroToolSpecification[];
    toolResults?: {
      toolUseId: string;
      status: "success" | "error";
      content: { text: string }[];
    }[];
  };
  modelId: string;
  origin: "AI_EDITOR" | "CLI";
};

export type KiroAssistantResponseMessage = {
  content: string;
  toolUses?: {
    toolUseId: string;
    name: string;
    input: unknown;
  }[];
};

export type KiroHistoryEntry =
  | { userInputMessage: KiroUserInputMessage }
  | { assistantResponseMessage: KiroAssistantResponseMessage };

export type KiroRequest = {
  conversationState: {
    /** Fresh per request — §6. */
    conversationId: string;
    chatTriggerType: "MANUAL";
    currentMessage: { userInputMessage: KiroUserInputMessage };
    history: KiroHistoryEntry[];
  };
  /** Present only when the account has one; never logged (§17). */
  profileArn?: string;
};

export type TransformOptions = {
  /** Upstream model ID from the model registry — never the public ID (§9). */
  upstreamModelId: string;
  persona: Persona;
  profileArn: string | null;
  /**
   * False when the tool-use kill switch is off (§3). Tools are then dropped
   * entirely and the turn runs as plain text, which is the documented behaviour
   * of that switch.
   */
  toolsEnabled: boolean;
};

export type TransformResult = {
  request: KiroRequest;
  /** Recorded on the usage row (§3 "Compatibility versioning"). */
  fixtureVersion: string;
  /** The conversation ID actually used, for correlation in operator logs. */
  conversationId: string;
};

const invalid = (detail: string): never => {
  throw new BosandaError("invalid_request", { internalDetail: detail });
};

/**
 * True when a tool name implies a host capability (filesystem, shell, MCP, or
 * process environment).
 *
 * This is a CLASSIFIER, not a gate. A client may legitimately declare any of
 * these and execute them on its own machine — see the note on
 * `HOST_CAPABILITY_PATTERNS`. It exists so `assertNoInjectedTools` can report
 * precisely which injected name it caught, and so the §3 gate harness can assert
 * the classification independently.
 */
export function isHostCapabilityToolName(name: string): boolean {
  return HOST_CAPABILITY_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * Enforces §6 "Never inject filesystem, shell, MCP, or host-environment tools"
 * STRUCTURALLY: every tool going upstream must be one the client declared.
 *
 * Comparing outbound against declared is what actually makes the invariant
 * testable. A name-based blocklist could only ever guess at intent, and it
 * cannot catch the case that matters — Bosanda adding a tool called
 * `helpful_assistant` that happens to read files.
 *
 * `unsupported_capability` would be the wrong code here: nothing about the
 * CLIENT's request is unsupported. An injected tool means Bosanda constructed a
 * bad upstream request, which is `internal_error`, and it fails the request
 * rather than quietly stripping the extra tool.
 */
export function assertNoInjectedTools(
  outbound: readonly KiroToolSpecification[],
  declared: readonly { name: string }[],
): void {
  const allowed = new Set(declared.map((tool) => tool.name));
  for (const tool of outbound) {
    const name = tool.toolSpecification.name;
    if (!allowed.has(name)) {
      throw new BosandaError("internal_error", {
        internalDetail:
          `refusing to send tool "${name}" upstream: the client did not declare it` +
          (isHostCapabilityToolName(name) ? " and it names a host capability" : ""),
      });
    }
  }
}

/**
 * Throws when text carries Bosanda server context (§16).
 *
 * Applied to the system prompt and to every outbound message body. This is a
 * guard against OUR OWN future bugs — a client is free to paste whatever it
 * likes, but if a Bosanda secret name or deployment path shows up in an outbound
 * prompt it almost certainly got there through a template we added, and failing
 * the request is the correct response to that.
 */
export function assertNoServerContext(text: string, where: string): void {
  for (const { pattern, what } of SERVER_CONTEXT_PATTERNS) {
    if (pattern.test(text)) {
      // Names WHAT was found, never the matched text itself.
      throw new BosandaError("internal_error", {
        internalDetail: `refusing to send ${where} upstream: it contains ${what}`,
      });
    }
  }
}

/**
 * Flattens canonical content into the single text field Kiro accepts.
 *
 * `reasoning` content from a prior assistant turn is dropped rather than
 * replayed: it is the model's own scratchpad, upstream regenerates it, and
 * echoing it back inflates input tokens the customer pays for (§10).
 */
function flattenText(content: readonly CanonicalContent[]): string {
  const parts: string[] = [];
  for (const item of content) {
    if (item.type === "text") parts.push(item.text);
  }
  return parts.join("");
}

/** Merges consecutive same-role messages (§6 "Merge or reject ... deterministically"). */
function mergeConsecutiveRoles(
  messages: readonly { role: "user" | "assistant"; content: CanonicalContent[] }[],
): { role: "user" | "assistant"; content: CanonicalContent[] }[] {
  const merged: { role: "user" | "assistant"; content: CanonicalContent[] }[] = [];
  for (const message of messages) {
    const last = merged[merged.length - 1];
    if (last !== undefined && last.role === message.role) {
      last.content = [...last.content, ...message.content];
    } else {
      merged.push({ role: message.role, content: [...message.content] });
    }
  }
  return merged;
}

/**
 * Maps client-declared tools to the upstream shape.
 *
 * Every declared tool is forwarded, including ones named `Bash` or `Read`: they
 * run on the CLIENT's machine, and §3 G3 requires that loop to work. Nothing is
 * added here, which is the invariant `assertNoInjectedTools` then verifies.
 */
function toolSpecs(request: CanonicalRequest, toolsEnabled: boolean): KiroToolSpecification[] {
  if (!toolsEnabled) return [];

  return request.tools.map((tool) => ({
    toolSpecification: {
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: { json: tool.inputSchema },
    },
  }));
}

/**
 * Builds the upstream request.
 *
 * A FRESH `conversationId` is minted on every call. Two calls with an identical
 * CanonicalRequest produce two different IDs, which is what §6 requires and what
 * the test suite asserts.
 */
export function transformRequest(
  request: CanonicalRequest,
  options: TransformOptions,
): TransformResult {
  if (request.messages.length === 0) invalid("cannot transform a request with no messages");

  const origin = options.persona === "cli" ? "CLI" : "AI_EDITOR";
  const tools = toolSpecs(request, options.toolsEnabled);
  // Invariant 2, checked against what the client actually sent rather than
  // against a list of names we guessed at.
  assertNoInjectedTools(tools, request.tools);

  if (request.system !== null) assertNoServerContext(request.system, "the system prompt");

  const merged = mergeConsecutiveRoles(request.messages);

  // The final message must be from the user: it becomes `currentMessage`. A
  // trailing assistant message means the client wants a continuation, which this
  // wire shape has no representation for.
  const current = merged[merged.length - 1];
  if (current === undefined || current.role !== "user") {
    return invalid("the last message must be from the user after role merging");
  }

  const history: KiroHistoryEntry[] = [];
  for (let i = 0; i < merged.length - 1; i += 1) {
    const message = merged[i]!;
    const text = flattenText(message.content);
    assertNoServerContext(text, `history message ${i}`);

    if (message.role === "assistant") {
      const toolUses = message.content
        .filter(
          (item): item is Extract<CanonicalContent, { type: "tool_use" }> =>
            item.type === "tool_use",
        )
        // Tool IDs are preserved verbatim (§6): the client correlates its
        // tool_result against exactly these, so rewriting them breaks the loop.
        .map((item) => ({ toolUseId: item.id, name: item.name, input: item.input }));

      history.push({
        assistantResponseMessage: {
          content: text,
          ...(toolUses.length > 0 ? { toolUses } : {}),
        },
      });
      continue;
    }

    // Tool specs are attached to the CURRENT message only, never replayed across
    // history: they are identical on every turn, and repeating a large Claude
    // Code tool block per historical message would inflate the input tokens the
    // customer is billed for (§10) without changing the result.
    history.push({
      userInputMessage: buildUserMessage(
        message.content,
        text,
        options,
        origin,
        [],
        i === 0 ? request.system : null,
      ),
    });
  }

  const currentText = flattenText(current.content);
  assertNoServerContext(currentText, "the current message");

  // The system prompt rides on the first user turn when there is history, and on
  // the current message otherwise — this wire shape has no dedicated field.
  const systemForCurrent = history.length === 0 ? request.system : null;

  const id = conversationId();

  return {
    request: {
      conversationState: {
        conversationId: id,
        chatTriggerType: "MANUAL",
        currentMessage: {
          userInputMessage: buildUserMessage(
            current.content,
            currentText,
            options,
            origin,
            tools,
            systemForCurrent,
          ),
        },
        history,
      },
      ...(options.profileArn !== null ? { profileArn: options.profileArn } : {}),
    },
    fixtureVersion: FIXTURE_VERSION,
    conversationId: id,
  };
}

function buildUserMessage(
  content: readonly CanonicalContent[],
  text: string,
  options: TransformOptions,
  origin: KiroUserInputMessage["origin"],
  tools: KiroToolSpecification[],
  system: string | null,
): KiroUserInputMessage {
  const toolResults = content
    .filter(
      (item): item is Extract<CanonicalContent, { type: "tool_result" }> =>
        item.type === "tool_result",
    )
    .map((item) => ({
      toolUseId: item.toolUseId,
      status: item.isError ? ("error" as const) : ("success" as const),
      content: [{ text: item.content }],
    }));

  const body = system === null ? text : `${system}\n\n${text}`;

  return {
    content: body,
    userInputMessageContext: {
      ...(tools.length > 0 ? { tools } : {}),
      ...(toolResults.length > 0 ? { toolResults } : {}),
    },
    modelId: options.upstreamModelId,
    origin,
  };
}
