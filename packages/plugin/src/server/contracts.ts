import type { PaseoApi } from "@getpaseo/client";
import type { ZodType, input as ZodInput, output as ZodOutput } from "zod";
import type { PluginRpcContract } from "../rpc.js";
import type { PluginCleanup } from "../contracts.js";
import type { ProviderRegistration } from "./provider.js";
import type { UsageSourceRegistration } from "./usage.js";
import type { PluginLifecycleRegistration } from "./lifecycle.js";

export interface PluginHandlerContext {
  paseo: PaseoApi;
  /** Set when the host invoked this method on behalf of an agent-facing tool. */
  callerAgentId?: string | null;
}

/** A tool a plugin contributes to the Paseo agent tool catalog (for example `vibe_tabs`). */
export interface PluginAgentTool {
  name: string;
  description: string;
  input?: ZodType;
  handler(input: unknown, context: { callerAgentId: string | null }): unknown | Promise<unknown>;
}

export type PluginSettingsState<Schema extends ZodType> =
  | {
      status: "ready";
      revision: string;
      values: ZodOutput<Schema>;
    }
  | {
      status: "invalid";
      revision: string;
      error: string;
    };

export interface PluginSettings<Schema extends ZodType> {
  read(): Promise<PluginSettingsState<Schema>>;
  subscribe(listener: (state: PluginSettingsState<Schema>) => void | Promise<void>): PluginCleanup;
}

/** A push notification a plugin asks the daemon to send to the user's paired devices. */
export interface PluginNotification {
  title: string;
  body: string;
  data?: Record<string, unknown>;
  /**
   * Set when this restates an agent attention Paseo already pushes by itself (for example an agent
   * waiting for a permission). The daemon skips the push if it handled that attention recently.
   */
  agentAttention?: { agentId: string; reason: "permission" | "finished" | "error" };
}

export interface PluginServerContext extends PluginLifecycleRegistration {
  /** The plugin's Paseo API, usable as soon as contribute() runs (no hook or RPC needed first). */
  paseo: PaseoApi;
  /**
   * Sends a push notification through the daemon's push service. With minimal payloads enabled the
   * daemon truncates the text and keeps only short string fields of data; keep content out of it.
   */
  notify(notification: PluginNotification): void;
  registerSettings<Schema extends ZodType>(
    definition: import("../settings.js").SettingsDefinition<Schema>,
  ): PluginSettings<Schema>;
  handle<InputSchema extends ZodType, OutputSchema extends ZodType>(
    contract: PluginRpcContract<InputSchema, OutputSchema>,
    handler: (
      input: ZodOutput<InputSchema>,
      context: PluginHandlerContext,
    ) => ZodInput<OutputSchema> | Promise<ZodInput<OutputSchema>>,
  ): void;
  registerProvider(provider: ProviderRegistration): void;
  registerUsageSource(source: UsageSourceRegistration): void;
  registerAgentTool(tool: PluginAgentTool): void;
}

export type PluginServerContribution = (server: PluginServerContext) => PluginCleanup;
