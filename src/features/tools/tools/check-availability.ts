import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../core/tool";
import {
  buildAvailabilityOutput,
  groupByDay,
  resolveTimeZone,
  zonedDayRange,
} from "../lib/slots";

const schema = z.object({
  date_from: z
    .string()
    .describe("Fecha inicial del rango a consultar (ISO, ej: 2026-06-12)"),
  date_to: z.string().describe("Fecha final del rango (ISO, ej: 2026-06-19)"),
  timezone: z
    .string()
    .optional()
    .describe("Zona horaria IANA, ej: America/Mexico_City"),
  calendar_id: z
    .string()
    .optional()
    .describe(
      "ID del calendario de HighLevel (usa el del workspace si se omite)",
    ),
});

type Args = z.infer<typeof schema>;

// GHL free-slots returns an object keyed by date: { "2026-06-12": { slots: [...] }, ... }
// plus non-date keys (e.g. traceId) treated as metadata. Cualquier otra
// clave significa que la respuesta no es la que conocemos: ver readSlots.
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const META_KEYS = new Set(["traceId"]);

interface FreeSlotsResponse {
  [key: string]: { slots?: string[] } | unknown;
}

/**
 * Slots de la respuesta de GHL, o `null` si la respuesta **no se entendiÃ³**.
 *
 * El criterio es positivo a propÃ³sito: enumerar formas ilegibles desde abajo
 * siempre deja alguna capa mÃ¡s arriba que convierte un cuerpo desconocido en
 * "No hay horarios disponibles". AcÃ¡ la tool solo puede afirmar ausencia de
 * cupos si RECONOCIÃ la respuesta: un objeto cuyas claves son dÃ­as
 * `YYYY-MM-DD` con `{ slots: [] }`, mÃ¡s metadatos conocidos. Cualquier otra
 * cosa âun 200 con `{status:"error"}`, los dÃ­as dentro de otra envoltura, un
 * `slots` que no es arregloâ es un error explÃ­cito, no una agenda vacÃ­a.
 *
 * Residuo conocido: un cuerpo sin ningÃºn dÃ­a y sin claves inesperadas (`{}` o
 * solo `traceId`) se lee como vacÃ­o: no se distingue de un rango legÃ­timamente
 * sin cupos.
 */
function readSlots(data: unknown): unknown[] | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const slots: unknown[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (META_KEYS.has(key)) continue;
    if (!DATE_KEY.test(key)) return null;
    const inner = (value as { slots?: unknown } | null)?.slots;
    if (!Array.isArray(inner)) return null;
    slots.push(...inner);
  }
  return slots;
}

/**
 * Filters out slots that fall after `lastSlotTime` (e.g. "17:30") in the
 * business's local timezone. Returns only slots whose local HH:MM â¤ the cap.
 */
function filterSlotsByCutoff(
  slots: unknown[],
  tz: string,
  lastSlotTime: string,
): unknown[] {
  const [capH, capM] = lastSlotTime.split(":").map(Number);
  if (Number.isNaN(capH) || Number.isNaN(capM)) return slots;
  const capMinutes = capH * 60 + capM;
  return slots.filter((raw) => {
    if (typeof raw !== "string") return true; // keep unreadable for groupByDay to count
    const instant = Date.parse(raw);
    if (Number.isNaN(instant)) return true;
    let local: string;
    try {
      local = new Date(instant).toLocaleString("sv-SE", { timeZone: tz });
    } catch {
      return true; // can't resolve tz â keep the slot
    }
    const timePart = local.split(" ")[1]; // "HH:MM:SS"
    if (!timePart) return true;
    const [h, m] = timePart.split(":").map(Number);
    return h * 60 + m <= capMinutes;
  });
}

async function run(args: Args, ctx: ToolContext): Promise<ToolResult> {
  const { getHLConfig } = await import("../../inbox/services/highlevel-client");
  const { getBusinessInfo } = await import("../../inbox/services/business-info");

  const cfg = await getHLConfig(ctx.workspaceId);
  if (!cfg) {
    return {
      ok: false,
      output: null,
      error: "HighLevel no estÃ¡ conectado para este workspace",
    };
  }

  const calendarId = args.calendar_id ?? cfg.calendarId;
  if (!calendarId) {
    return {
      ok: false,
      output: null,
      error: "No hay un calendario de HighLevel configurado",
    };
  }

  // El rango se interpreta en la zona que pida el LLM, o la del negocio, o la
  // de la integraciÃ³n de HighLevel, o UTC â la primera que sea IANA vÃ¡lida.
  // `date_to` queda inclusivo hasta el final de ese dÃ­a, en hora local.
  // La zona del LLM es texto libre: si no es vÃ¡lida se cae a la siguiente y el
  // output lo declara, en vez de etiquetar una zona que no se usÃ³ (el bot
  // ofrecÃ­a "12:00" que en Santiago eran las 09:00). La del negocio va antes
  // que la de HighLevel porque esa vale "UTC" cuando nadie la configurÃ³.
  const businessInfo = await getBusinessInfo(ctx.workspaceId);
  const businessTz = (businessInfo?.structured as { timezone?: string } | null)
    ?.timezone;
  const tz = resolveTimeZone(args.timezone, businessTz, cfg.timezone);
  const range = zonedDayRange(args.date_from, args.date_to, tz);
  if (!range) {
    return { ok: false, output: null, error: "Fechas invÃ¡lidas" };
  }
  const { startMs, endMs } = range;

  const params = new URLSearchParams({
    startDate: String(startMs),
    endDate: String(endMs),
    timezone: tz,
  });

  const res = await fetch(
    `https://services.leadconnectorhq.com/calendars/${calendarId}/free-slots?${params.toString()}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Version: "2021-07-28",
      },
    },
  );

  if (!res.ok) {
    // The raw body is HighLevel's own wording (English, internal ids): log
    // it, but give the model a plain reason it can relay.
    console.error(
      `[check_availability] HighLevel ${res.status}:`,
      (await res.text()).slice(0, 300),
    );
    return {
      ok: false,
      output: null,
      error: `El calendario de HighLevel respondiÃ³ con un error (${res.status}); no se pudo consultar la disponibilidad. Dile al cliente que lo revisarÃ¡s o pÃ¡salo a una persona.`,
    };
  }

  const data = (await res.json()) as FreeSlotsResponse;
  const all = readSlots(data);

  if (all === null) {
    return {
      ok: false,
      output: null,
      error:
        "El calendario respondiÃ³ en un formato que no se pudo interpretar; no se sabe si hay horarios libres",
    };
  }

  // ââ Slot cutoff: filter out slots past the configured last-slot time ââ
  const schedulingRules = (businessInfo?.structured as {
    scheduling_rules?: { enabled?: boolean; last_slot_time?: string };
  } | null)?.scheduling_rules;
  const filtered =
    schedulingRules?.enabled && schedulingRules.last_slot_time
      ? filterSlotsByCutoff(all, tz, schedulingRules.last_slot_time)
      : all;

  const grouped = groupByDay(filtered, tz);
  return {
    ok: true,
    output: buildAvailabilityOutput(grouped, tz, args.timezone),
  };
}

export const checkAvailabilityTool: Tool<Args> = {
  name: "check_availability",
  description:
    "Consulta los horarios libres reales del calendario de HighLevel en un rango de fechas. Ãsalo ANTES de agendar para ofrecer al cliente horarios que sÃ­ existen.",
  sensitivity: "read",
  schema,
  enabledFor: () => true,
  run,
};
