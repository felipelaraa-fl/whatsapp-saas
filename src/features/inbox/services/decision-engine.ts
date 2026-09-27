// F3-T4: Decision engine — orchestrates respond / handoff / abstain.
// Uses service-role client for DB state transitions.

import { createClient as createSbClient } from "@supabase/supabase-js";
import {
  aiShouldRespond,
  canTransition,
  detectsHandoffTrigger,
  type ConversationState,
} from "./state-machine";
import { reserveLlmTurn } from "./cost-tracker";
import { getEnabledTools } from "@/features/tools/services/tool-configs";
import { shouldAbstainForSchedule } from "./schedule-guard";
import type { Tool } from "@/features/tools/core/tool";

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

export type Decision = "respond" | "handoff" | "abstain" | "rate_limited";

export interface DecisionResult {
  decision: Decision;
  reason: string;
  availableTools?: Tool[];
  reservationId?: string;
}

/**
 * Decides whether the AI should respond, trigger a handoff, or abstain.
 *
 * Flow:
 *   1. Load conversation state from DB
 *   2. If state !== 'ai_active' → abstain
 *   2b. If within human business hours (ai_schedule) → abstain
 *   3. detectsHandoffTrigger → if true, transition to handoff_pending and log
 *   4. load the enabled tools
 *   5. reserveLlmTurn (last: nothing may throw after it) → if exceeded,
 *      return rate_limited; otherwise respond
 */
export async function decide(opts: {
  workspaceId: string;
  conversationId: string;
  mergedText: string;
  contactId: string;
  /**
   * The turn slot an earlier attempt of the same batch already reserved. A
   * retry reuses it instead of spending a second slot of the hourly limit.
   */
  reservationId?: string;
}): Promise<DecisionResult> {
  const { workspaceId, conversationId, mergedText, contactId } = opts;
  const supabase = svc();

  // 1. Load conversation state
  const { data: conv, error: convError } = await supabase
    .from("conversations")
    .select("state")
    .eq("id", conversationId)
    .single();

  if (convError || !conv) {
    console.error("[decision-engine] failed to load conversation:", convError);
    return { decision: "abstain", reason: "conversation_not_found" };
  }

  const currentState = conv.state as ConversationState;

  // 2. Check if AI should respond in current state
  if (!aiShouldRespond(currentState)) {
    return { decision: "abstain", reason: `state:${currentState}` };
  }

  // 2b. Check if we're within human business hours (agent schedule)
  try {
    const withinHumanHours = await shouldAbstainForSchedule(workspaceId);
    if (withinHumanHours) {
      return { decision: "abstain", reason: "within_human_hours" };
    }
  } catch (err) {
    // Non-fatal: if schedule check fails, let the agent respond anyway
    console.error("[decision-engine] schedule check failed:", err);
  }

  // 3. Detect handoff trigger in message text
  if (detectsHandoffTrigger(mergedText)) {
    if (canTransition(currentState, "handoff_pending")) {
      await applyTransition(conversationId, "handoff_pending", {
        trigger: "keyword",
      });
    }

    return { decision: "handoff", reason: "handoff_trigger" };
  }

  // 4. Load the enabled tools first: once a turn slot is reserved nothing in
  // here may throw, or the slot would be spent with no one holding its id.
  const availableTools = await getEnabledTools(workspaceId);

  // 5. Rate limit check
  const {
    allowed,
    reason: rateLimitReason,
    reservationId,
  } = opts.reservationId
    ? { allowed: true, reason: undefined, reservationId: opts.reservationId }
    : await reserveLlmTurn(workspaceId, contactId);

  if (!allowed) {
    return {
      decision: "rate_limited",
      reason: rateLimitReason ?? "rate_limited",
    };
  }

  return { decision: "respond", reason: "normal", availableTools, reservationId };
}

export interface TransitionOptions {
  userId?: string;
  trigger?: string;
  workspaceId?: string;
}

export async function applyTransition(
  conversationId: string,
  to: ConversationState,
  opts: TransitionOptions = {},
): Promise<void> {
  const { userId, trigger, workspaceId } = opts;
  const supabase = svc();

  let lookup = supabase
    .from("conversations")
    .select("state, workspace_id")
    .eq("id", conversationId);
  if (workspaceId) lookup = lookup.eq("workspace_id", workspaceId);
  const { data: conv, error: convError } = await lookup.single();

  if (convError || !conv) {
    throw new Error(
      `[decision-engine] conversation not found: ${convError?.message}`,
    );
  }

  const currentState = conv.state as ConversationState;

  if (!canTransition(currentState, to)) {
    const { TransitionError } = await import("./state-machine");
    throw new TransitionError(currentState, to);
  }

  const updatePayload: Record<string, unknown> = {
    state: to,
    ai_enabled: to === "ai_active",
    updated_at: new Date().toISOString(),
  };

  if (to === "human_active" && userId) {
    updatePayload.assigned_to = userId;
  }

  let update = supabase
    .from("conversations")
    .update(updatePayload)
    .eq("id", conversationId);
  if (workspaceId) update = update.eq("workspace_id", workspaceId);
  const { error: updateError } = await update;

  if (updateError) {
    throw new Error(
      `[decision-engine] failed to apply transition: ${updateError.message}`,
    );
  }

  await supabase.from("events").insert({
    type: "state_change",
    level: "info",
    workspace_id: conv.workspace_id,
    conversation_id: conversationId,
    payload: {
      from: currentState,
      to,
      actor: userId ?? "system",
      ...(trigger ? { trigger } : {}),
    },
  });

  if (to === "handoff_pending") {
    try {
      const { notifyHandoffPending } = await import("./handoff-notifier");
      await notifyHandoffPending({
        workspaceId: conv.workspace_id as string,
        conversationId,
        trigger: trigger ?? (userId ? "manual" : "agent"),
      });
    } catch (err) {
      console.error(
        "[decision-engine] failed to notify handoff_pending:",
        err instanceof Error ? err.message : err,
      );
    }
  }
}
