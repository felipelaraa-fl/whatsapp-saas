/**
 * Scheduling-rules API — GET/PUT for workspace appointment-scheduling config.
 *
 * Merges `scheduling_rules` into `business_info.structured` without clobbering
 * other keys (timezone, name, ai_schedule, etc.).
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import {
  getBusinessInfo,
  upsertBusinessInfo,
} from "@/features/inbox/services/business-info";

const SchedulingRulesSchema = z.object({
  enabled: z.boolean(),
  last_slot_time: z.string().regex(/^\d{2}:\d{2}$/, "Formato HH:MM"),
  same_day_cutoff: z.string().regex(/^\d{2}:\d{2}$/, "Formato HH:MM"),
  same_day_afternoon_start: z.string().regex(/^\d{2}:\d{2}$/, "Formato HH:MM"),
  clinic_hours: z.string().max(200).optional(),
});

// ── GET /api/workspace/[id]/scheduling-rules ────────────────────────────────
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;

  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const { data: member } = await supabase
    .from("memberships")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!member) {
    return NextResponse.json({ error: "Acceso denegado" }, { status: 403 });
  }

  const info = await getBusinessInfo(workspaceId);
  const rules = (info?.structured as { scheduling_rules?: unknown } | null)
    ?.scheduling_rules ?? null;

  return NextResponse.json({ data: rules });
}

// ── PUT /api/workspace/[id]/scheduling-rules ────────────────────────────────
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;

  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const { data: member } = await supabase
    .from("memberships")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!member || !["admin", "manager"].includes(member.role as string)) {
    return NextResponse.json({ error: "Acceso denegado" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body inválido" }, { status: 400 });
  }

  const parsed = SchedulingRulesSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    // Merge into existing structured data without clobbering other keys.
    const existing = await getBusinessInfo(workspaceId);
    const structured = {
      ...((existing?.structured as Record<string, unknown>) ?? {}),
      scheduling_rules: parsed.data,
    };
    await upsertBusinessInfo(workspaceId, { structured });
    return NextResponse.json({ success: true, data: parsed.data });
  } catch (err) {
    console.error("[PUT /api/workspace/[id]/scheduling-rules]:", err);
    return NextResponse.json(
      { error: "Error interno del servidor" },
      { status: 500 },
    );
  }
}
