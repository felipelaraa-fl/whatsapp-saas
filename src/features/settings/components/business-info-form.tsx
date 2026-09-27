"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

interface ScheduleBlock {
  days: number[];
  from: string;
  to: string;
}

interface AiSchedule {
  enabled: boolean;
  blocks: ScheduleBlock[];
}

const DEFAULT_BLOCKS: ScheduleBlock[] = [
  { days: [1, 2, 3, 4, 5], from: "10:00", to: "13:30" },
  { days: [1, 2, 3, 4, 5], from: "15:00", to: "18:00" },
];

const DAY_LABELS = [
  { value: 0, short: "Dom" },
  { value: 1, short: "Lun" },
  { value: 2, short: "Mar" },
  { value: 3, short: "Mié" },
  { value: 4, short: "Jue" },
  { value: 5, short: "Vie" },
  { value: 6, short: "Sáb" },
];

const COUNTRY_CODES: { code: string; label: string }[] = [
  { code: "52", label: "México (+52)" },
  { code: "34", label: "España (+34)" },
  { code: "57", label: "Colombia (+57)" },
  { code: "54", label: "Argentina (+54)" },
  { code: "51", label: "Perú (+51)" },
  { code: "56", label: "Chile (+56)" },
  { code: "593", label: "Ecuador (+593)" },
  { code: "502", label: "Guatemala (+502)" },
  { code: "1", label: "EE. UU. / Canadá (+1)" },
];

// Used for the agent's date/time context (agendamiento). Cancún is UTC-5 and
// CDMX is UTC-6 — picking the right one matters for booking.
const TIMEZONES: { value: string; label: string }[] = [
  { value: "America/Mexico_City", label: "CDMX / centro de México (UTC-6)" },
  { value: "America/Cancun", label: "Cancún / Quintana Roo (UTC-5)" },
  { value: "America/Tijuana", label: "Tijuana / Baja California (UTC-8)" },
  { value: "America/Hermosillo", label: "Hermosillo / Sonora (UTC-7)" },
  { value: "America/Bogota", label: "Colombia (UTC-5)" },
  { value: "America/Lima", label: "Perú (UTC-5)" },
  { value: "America/Santiago", label: "Chile (UTC-3/-4)" },
  { value: "America/Argentina/Buenos_Aires", label: "Argentina (UTC-3)" },
  { value: "America/Guatemala", label: "Guatemala (UTC-6)" },
  { value: "America/New_York", label: "EE. UU. Este (UTC-5/-4)" },
  { value: "Europe/Madrid", label: "España (UTC+1/+2)" },
];

interface Props {
  workspaceId: string;
  initial: {
    structured: Record<string, unknown>;
    free_text: string | null;
  } | null;
}

export function BusinessInfoForm({ workspaceId, initial }: Props) {
  const structured = initial?.structured ?? {};

  const [freeText, setFreeText] = useState(initial?.free_text ?? "");
  const [name, setName] = useState((structured.name as string) ?? "");
  const [horarios, setHorarios] = useState(
    (structured.horarios as string) ?? "",
  );
  const [industria, setIndustria] = useState(
    (structured.industria as string) ?? "",
  );
  const [countryCode, setCountryCode] = useState(
    (structured.default_country_code as string) ?? "52",
  );
  const [timezone, setTimezone] = useState(
    (structured.timezone as string) ?? "America/Mexico_City",
  );

  // AI schedule state
  const savedSchedule = structured.ai_schedule as AiSchedule | undefined;
  const [scheduleEnabled, setScheduleEnabled] = useState(
    savedSchedule?.enabled ?? false,
  );
  const [scheduleBlocks, setScheduleBlocks] = useState<ScheduleBlock[]>(
    savedSchedule?.blocks ?? DEFAULT_BLOCKS,
  );

  const [saving, setSaving] = useState(false);
  const router = useRouter();

  function updateBlock(idx: number, field: "from" | "to", value: string) {
    setScheduleBlocks((prev) =>
      prev.map((b, i) => (i === idx ? { ...b, [field]: value } : b)),
    );
  }

  function toggleDay(blockIdx: number, day: number) {
    setScheduleBlocks((prev) =>
      prev.map((b, i) => {
        if (i !== blockIdx) return b;
        const days = b.days.includes(day)
          ? b.days.filter((d) => d !== day)
          : [...b.days, day].sort();
        return { ...b, days };
      }),
    );
  }

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch(`/api/workspace/${workspaceId}/business-info`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          free_text: freeText || null,
          structured: {
            ...structured,
            name: name || undefined,
            horarios: horarios || undefined,
            industria: industria || undefined,
            default_country_code: countryCode || undefined,
            timezone: timezone || undefined,
            ai_schedule: {
              enabled: scheduleEnabled,
              blocks: scheduleBlocks,
            },
          },
        }),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error ?? "Error al guardar");
      }

      toast.success("Información guardada");
      // Refresh the server data so the (re-mounting) tab shows what was saved.
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Error al guardar");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="bi-free-text" className="text-sm font-medium">
          Información libre del negocio
        </Label>
        <Textarea
          id="bi-free-text"
          rows={4}
          placeholder="Describe tu negocio, servicios, precios, horarios..."
          value={freeText}
          onChange={(e) => setFreeText(e.target.value)}
          className="resize-none"
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="bi-name" className="text-sm font-medium">
            Nombre del negocio
          </Label>
          <Input
            id="bi-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ej: Clínica Dental Norte"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="bi-industria" className="text-sm font-medium">
            Industria
          </Label>
          <Input
            id="bi-industria"
            value={industria}
            onChange={(e) => setIndustria(e.target.value)}
            placeholder="Ej: Salud, Educación, Retail..."
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="bi-horarios" className="text-sm font-medium">
          Horarios
        </Label>
        <Input
          id="bi-horarios"
          value={horarios}
          onChange={(e) => setHorarios(e.target.value)}
          placeholder="Ej: Lun–Vie 9:00–18:00, Sáb 10:00–14:00"
        />
      </div>

      <div className="space-y-1.5 sm:max-w-xs">
        <Label htmlFor="bi-country" className="text-sm font-medium">
          País por defecto
        </Label>
        <Select value={countryCode} onValueChange={setCountryCode}>
          <SelectTrigger id="bi-country">
            <SelectValue placeholder="Elige un país" />
          </SelectTrigger>
          <SelectContent>
            {COUNTRY_CODES.map((c) => (
              <SelectItem key={c.code} value={c.code}>
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11px] text-muted-foreground">
          Se usa para números de WhatsApp que llegan sin código de país.
        </p>
      </div>

      <div className="space-y-1.5 sm:max-w-xs">
        <Label htmlFor="bi-timezone" className="text-sm font-medium">
          Zona horaria
        </Label>
        <Select value={timezone} onValueChange={setTimezone}>
          <SelectTrigger id="bi-timezone">
            <SelectValue placeholder="Elige zona horaria" />
          </SelectTrigger>
          <SelectContent>
            {TIMEZONES.map((tz) => (
              <SelectItem key={tz.value} value={tz.value}>
                {tz.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11px] text-muted-foreground">
          El agente la usa para interpretar &ldquo;hoy/mañana&rdquo; y agendar a
          la hora correcta. Cancún es UTC-5; CDMX es UTC-6.
        </p>
      </div>

      {/* ── AI Schedule ─────────────────────────────────────────────── */}
      <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-sm font-medium">
              Horario del agente IA
            </Label>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Cuando está activado, el agente solo responde{" "}
              <strong>fuera</strong> del horario configurado. Durante el
              horario, tu equipo humano atiende.
            </p>
          </div>
          <Switch
            checked={scheduleEnabled}
            onCheckedChange={setScheduleEnabled}
            aria-label="Activar horario del agente"
          />
        </div>

        {scheduleEnabled && (
          <div className="space-y-4 pt-2">
            {scheduleBlocks.map((block, idx) => (
              <div key={idx} className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">
                  Bloque {idx + 1}
                </p>
                <div className="flex items-center gap-2">
                  <Input
                    type="time"
                    value={block.from}
                    onChange={(e) => updateBlock(idx, "from", e.target.value)}
                    className="w-28"
                    aria-label={`Bloque ${idx + 1} hora inicio`}
                  />
                  <span className="text-xs text-muted-foreground">a</span>
                  <Input
                    type="time"
                    value={block.to}
                    onChange={(e) => updateBlock(idx, "to", e.target.value)}
                    className="w-28"
                    aria-label={`Bloque ${idx + 1} hora fin`}
                  />
                </div>
                <div className="flex gap-1">
                  {DAY_LABELS.map((d) => (
                    <button
                      key={d.value}
                      type="button"
                      onClick={() => toggleDay(idx, d.value)}
                      className={`rounded px-2 py-1 text-[11px] font-medium transition-colors ${
                        block.days.includes(d.value)
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-muted-foreground hover:bg-muted/80"
                      }`}
                      aria-label={`${d.short} ${block.days.includes(d.value) ? "activado" : "desactivado"}`}
                      aria-pressed={block.days.includes(d.value)}
                    >
                      {d.short}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Button
        onClick={handleSave}
        disabled={saving}
        aria-busy={saving}
        size="sm"
      >
        {saving && (
          <Loader2 className="h-4 w-4 mr-2 animate-spin" aria-hidden="true" />
        )}
        {saving ? "Guardando..." : "Guardar información"}
      </Button>
    </div>
  );
}
