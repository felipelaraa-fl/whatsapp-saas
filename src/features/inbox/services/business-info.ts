// F7: Business info loader — loads structured + free_text data to inject into system prompts.

import { createClient as createSbClient } from "@supabase/supabase-js";
import { DEFAULT_TIMEZONE, resolveTimeZone } from "@/shared/lib/timezone";

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

export interface BusinessInfo {
  structured: Record<string, unknown>;
  free_text: string | null;
}

/**
 * Loads business info for a workspace from the business_info table.
 * Returns null when no record exists yet.
 */
export async function getBusinessInfo(
  workspaceId: string,
): Promise<BusinessInfo | null> {
  const supabase = svc();

  const { data, error } = await supabase
    .from("business_info")
    .select("structured, free_text")
    .eq("workspace_id", workspaceId)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("[business-info] getBusinessInfo error:", error);
    return null;
  }

  if (!data) return null;

  return {
    structured: (data.structured as Record<string, unknown>) ?? {},
    free_text: data.free_text ?? null,
  };
}

/** UTC offset (e.g. "-05:00") for a timezone right now. */
function offsetFor(timeZone: string, now: Date): string {
  const raw =
    new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
      .formatToParts(now)
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT+00:00";
  // "GMT-05:00" → "-05:00"; "GMT" (UTC) → "+00:00"
  return raw.replace("GMT", "") || "+00:00";
}

/**
 * Renders the next 7 calendar days in `timeZone` as "- <día>: YYYY-MM-DD" lines.
 *
 * Anchors "today" once via Intl (the only place `timeZone`-aware wall-clock
 * conversion happens), then advances by pure calendar-day arithmetic in UTC
 * space (`Date.UTC` normalizes day-of-month overflow). This is immune to
 * `timeZone`'s DST transitions — adding fixed 24h instants is not, because a
 * DST shift changes how many wall-clock hours a UTC day spans locally, which
 * can skip or duplicate a calendar date (see business-info.test.ts's DST
 * regression test).
 */
export function buildUpcomingDaysTable(timeZone: string, now: Date): string {
  const lines: string[] = ["## Próximos 7 días"];
  const todayIso = now.toLocaleDateString("en-CA", { timeZone }); // "YYYY-MM-DD" anchor
  const [year, month, day] = todayIso.split("-").map(Number);
  for (let i = 0; i < 7; i++) {
    const dayDate = new Date(Date.UTC(year, month - 1, day + i));
    const isoDate = dayDate.toISOString().slice(0, 10);
    // The weekday for a calendar date doesn't depend on the viewing timezone
    // once the date itself is correct — format against UTC to avoid a second
    // timeZone-aware conversion.
    const dayName = dayDate.toLocaleDateString("es-MX", {
      timeZone: "UTC",
      weekday: "long",
    });
    // Noon UTC of this calendar date is safely past every real-world DST
    // transition time (which happens in the small hours local), so it
    // always resolves to the offset that applies for the rest of that local
    // day — unlike reusing "now"'s offset, which is wrong for a date on the
    // other side of a DST change.
    const dayOffset = offsetFor(
      timeZone,
      new Date(Date.UTC(year, month - 1, day + i, 12)),
    );
    lines.push(`- ${dayName}: ${isoDate} (offset ${dayOffset})`);
  }
  return lines.join("\n");
}

/**
 * A workspace admin can save an arbitrary string as the business timezone
 * (business_info.structured.timezone has no server-side IANA validation).
 * An invalid one used to throw uncaught here, dead-lettering every message
 * in the workspace after 3 retries — fall back to the default instead. The
 * same resolver picks check_availability's zone, so both agree.
 */
export function buildNowContext(timeZone?: string | null): string {
  const tz = resolveTimeZone(timeZone);
  if (timeZone && tz !== timeZone.trim()) {
    console.warn(
      `[business-info] buildNowContext: invalid timezone "${timeZone}", falling back to ${DEFAULT_TIMEZONE}`,
    );
  }
  const now = new Date();
  const human = now.toLocaleString("es-MX", {
    timeZone: tz,
    dateStyle: "full",
    timeStyle: "short",
  });
  const offset = offsetFor(tz, now);
  const upcoming = buildUpcomingDaysTable(tz, now);
  return `## Fecha actual\nHoy es ${human} (zona horaria ${tz}, offset ${offset}).\n\n${upcoming}\n\nUsa esta tabla para resolver referencias como "el martes", "mañana", "en 3 días", etc. — copia la fecha exacta de la tabla, no la calcules tú. Cuando agendes, construye las horas en ISO con el offset que aparece junto a esa fecha en la tabla (no siempre es el mismo que el de "Hoy es...", puede cambiar por horario de verano), y pasa la zona horaria ${tz} a la herramienta de disponibilidad.`;
}

/**
 * Formats business info into a string block suitable for injection
 * at the top of an AI system prompt.
 * Returns an empty string when info is null.
 */
export function buildBusinessInfoContext(info: BusinessInfo | null): string {
  if (!info) return "";

  const lines: string[] = ["## Información del Negocio"];

  const hasStructured =
    info.structured && Object.keys(info.structured).length > 0;

  if (hasStructured) {
    lines.push(JSON.stringify(info.structured, null, 2));
  }

  if (info.free_text) {
    if (hasStructured) lines.push("");
    lines.push(info.free_text);
  }

  if (!hasStructured && !info.free_text) return "";

  return lines.join("\n");
}

// ── Scheduling-rules block for the system prompt ────────────────────────────
// Reads `structured.scheduling_rules` from business_info and builds a text
// block that instructs the agent how to handle appointment timing.

export interface SchedulingRules {
  enabled: boolean;
  /** Last bookable slot, e.g. "17:30". Slots after this are filtered out. */
  last_slot_time: string;
  /** Hour before which same-day afternoon booking is allowed, e.g. "12:00". */
  same_day_cutoff: string;
  /** Afternoon block start, e.g. "15:00". */
  same_day_afternoon_start: string;
  /** Clinic hours for display in the prompt. */
  clinic_hours?: string;
}

export function buildSchedulingRulesBlock(
  structured: Record<string, unknown> | null | undefined,
): string | null {
  const raw = (structured as { scheduling_rules?: SchedulingRules } | null)
    ?.scheduling_rules;
  if (!raw?.enabled) return null;

  const lastSlot = raw.last_slot_time ?? "17:30";
  const cutoff = raw.same_day_cutoff ?? "12:00";
  const afternoonStart = raw.same_day_afternoon_start ?? "15:00";
  const hours = raw.clinic_hours ?? "Lunes a Viernes, 10:00-13:30 y 15:00-18:00";

  return (
    "## Reglas de Agendamiento (OBLIGATORIAS)\n\n" +
    `Horario de atención: ${hours}.\n\n` +
    `1. NUNCA ofrezcas ni agendes una cita después de las ${lastSlot}. ` +
    `La última hora disponible es ${lastSlot}. Si check_availability devuelve ` +
    `horarios posteriores a las ${lastSlot}, ignóralos y no los ofrezcas al paciente.\n` +
    `2. Si el paciente quiere hora para HOY:\n` +
    `   - Si la hora actual es ANTES de las ${cutoff}: puedes ofrecer horarios de la tarde del mismo día (${afternoonStart}-${lastSlot}).\n` +
    `   - Si la hora actual es DESPUÉS de las ${cutoff}: NO ofrezcas hoy. Solo ofrece horarios a partir del SIGUIENTE día hábil (lunes a viernes).\n` +
    `   - Si es VIERNES después de las ${cutoff}: los próximos horarios disponibles son para el LUNES siguiente.\n` +
    `3. Cuando consultes check_availability, usa date_from del día correcto según estas reglas. ` +
    `NO consultes el día de hoy si ya pasó las ${cutoff}, consulta directamente desde mañana (o lunes si es viernes).\n` +
    `4. Si el paciente pide una hora específica que viole estas reglas, ` +
    `explícale amablemente que no hay disponibilidad y ofrécele la primera opción válida.\n` +
    `5. FINES DE SEMANA: la clínica NO atiende sábados ni domingos. ` +
    `Si el paciente pide hora para sábado o domingo, explícale amablemente que la clínica ` +
    `atiende solo de lunes a viernes y ofrécele la primera hora disponible del siguiente día hábil (lunes).\n` +
    `6. ESPECIALISTAS: si el paciente pregunta por una hora con un especialista o por una especialidad ` +
    `(dermatología, traumatología, cardiología, u otra), NO agendes directamente. ` +
    `Indícale que las horas de especialidad deben ser coordinadas por recepción ` +
    `y ofrécele pasar la conversación al equipo humano para que le ayuden con esa gestión.`
  );
}

/**
 * Upserts business info for a workspace.
 * Merges partial updates — only provided fields are overwritten.
 */
export async function upsertBusinessInfo(
  workspaceId: string,
  data: Partial<BusinessInfo>,
): Promise<void> {
  const supabase = svc();

  const payload: Record<string, unknown> = {
    workspace_id: workspaceId,
    updated_at: new Date().toISOString(),
  };

  if (data.structured !== undefined) payload.structured = data.structured;
  if (data.free_text !== undefined) payload.free_text = data.free_text;

  const { error } = await supabase
    .from("business_info")
    .upsert(payload, { onConflict: "workspace_id" });

  if (error) {
    console.error("[business-info] upsertBusinessInfo error:", error);
    throw new Error(`Failed to upsert business info: ${error.message}`);
  }
}
