/**
 * Schedule guard — checks whether the AI agent should stay quiet because
 * a human is available (within configured business hours).
 *
 * The workspace stores `ai_schedule` in business_info.structured:
 *   {
 *     enabled: true,
 *     blocks: [
 *       { days: [1,2,3,4,5], from: "10:00", to: "13:30" },
 *       { days: [1,2,3,4,5], from: "15:00", to: "18:00" }
 *     ]
 *   }
 *
 * `days` uses JS getDay() convention: 0=Sun, 1=Mon … 6=Sat.
 * `from`/`to` are "HH:MM" in the workspace's timezone.
 *
 * When `enabled` is true and the current time falls inside any block,
 * the agent abstains so the human can respond instead.
 */

import { createClient as createSbClient } from "@supabase/supabase-js";

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

export interface ScheduleBlock {
  days: number[];
  from: string; // "HH:MM"
  to: string;   // "HH:MM"
}

export interface AiSchedule {
  enabled: boolean;
  blocks: ScheduleBlock[];
}

/** Parse "HH:MM" into total minutes since midnight. */
function parseHHMM(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * Returns true when the current time (in the given timezone) falls
 * inside one of the schedule blocks — meaning a human is on duty
 * and the AI should NOT respond.
 */
export function isWithinHumanHours(
  schedule: AiSchedule,
  timezone: string,
): boolean {
  if (!schedule.enabled || !Array.isArray(schedule.blocks)) return false;

  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
    weekday: "short",
  });

  const parts = formatter.formatToParts(now);
  const hourStr = parts.find((p) => p.type === "hour")?.value ?? "0";
  const minuteStr = parts.find((p) => p.type === "minute")?.value ?? "0";
  const weekdayStr = parts.find((p) => p.type === "weekday")?.value ?? "";

  const nowMinutes = parseInt(hourStr, 10) * 60 + parseInt(minuteStr, 10);

  // Map short weekday to JS getDay() number
  const dayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  const currentDay = dayMap[weekdayStr] ?? new Date().getDay();

  for (const block of schedule.blocks) {
    if (!block.days.includes(currentDay)) continue;
    const from = parseHHMM(block.from);
    const to = parseHHMM(block.to);
    if (nowMinutes >= from && nowMinutes < to) {
      return true;
    }
  }

  return false;
}

/**
 * Loads the workspace's AI schedule config from business_info.
 * Returns null when no schedule is configured.
 */
export async function loadAiSchedule(
  workspaceId: string,
): Promise<{ schedule: AiSchedule | null; timezone: string }> {
  const supabase = svc();

  const { data, error } = await supabase
    .from("business_info")
    .select("structured")
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (error || !data?.structured) {
    return { schedule: null, timezone: "America/Mexico_City" };
  }

  const s = data.structured as Record<string, unknown>;
  const timezone = (s.timezone as string) || "America/Mexico_City";
  const aiSchedule = s.ai_schedule as AiSchedule | undefined;

  if (!aiSchedule?.enabled) {
    return { schedule: null, timezone };
  }

  return { schedule: aiSchedule, timezone };
}

/**
 * Quick check: should the AI abstain because a human is on duty right now?
 */
export async function shouldAbstainForSchedule(
  workspaceId: string,
): Promise<boolean> {
  const { schedule, timezone } = await loadAiSchedule(workspaceId);
  if (!schedule) return false;
  return isWithinHumanHours(schedule, timezone);
}
