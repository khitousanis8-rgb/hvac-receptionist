import { useEffect, useState, useMemo } from "react";
import { format, parse } from "date-fns";
import {
  Sidebar,
  SidebarBody,
  SidebarLink,
} from "@/components/ui/sidebar";
import {
  LayoutDashboard,
  PhoneCall,
  CalendarCheck,
  Settings,
  PhoneIncoming,
  ChevronDown,
  Radio,
  CalendarDays,
  Table as TableIcon,
  Phone,
  User,
  Clock,
  ShieldAlert,
  ArrowUpRight,
  Sparkles,
  TrendingUp,
  Monitor,
  Smartphone,
  Activity,
  Mic,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { cn, cleanTelHref } from "@/lib/utils";
import { apiUrl } from "@/lib/api";
import { LiveCallPage } from "@/components/ui/live-call-page";
import { FullScreenCalendar, CalendarData, Event as CalendarEvent } from "@/components/ui/fullscreen-calendar";
import { MobileBottomNav, Page } from "@/components/ui/mobile-bottom-nav";
import { MobileAgendaView } from "@/components/ui/mobile-agenda-view";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Reveal } from "@/components/ui/reveal";

export interface ClientMetricsData {
  first_assistant_audio_ms?: number | null;
  first_caller_transcript_ms?: number | null;
  echo_suppressions?: number;
  stt_errors?: number;
  tts_errors?: number;
  end_reason?: string | null;
  platform_class?: string | null;
  browser_engine?: string | null;
  input_path?: string | null;
  mic_permission?: string | null;
}

interface CallRecord {
  id: number;
  room_name: string;
  caller_phone: string | null;
  outcome: string;
  transcript_summary: string | null;
  started_at: string | null;
  ended_at: string | null;
  platform_class?: string | null;
  browser_engine?: string | null;
  input_path?: string | null;
  mic_permission?: string | null;
  end_reason?: string | null;
  client_telemetry?: ClientMetricsData | null;
  client_metrics?: ClientMetricsData | null;
}

interface Appointment {
  id: number;
  service: string;
  scheduled_for: string;
  status: string;
  notes: string | null;
  customer_name: string | null;
  customer_phone: string;
}

interface PublicConfig {
  company_name?: string;
  phone?: string;
  address?: string;
  timezone?: string;
  emergency_phone?: string;
  opening_hours?: Record<string, string>;
  services?: string[];
}

interface ApiState<T> {
  data: T[];
  total: number;
  outcomeCounts: Record<string, number>;
  loaded: boolean;
  error: boolean;
  status: number | null;
  updatedAt: Date | null;
}

function useApi<T>(path: string, refreshMs = 10000, adminKey?: string | null): ApiState<T> {
  const [state, setState] = useState<ApiState<T>>({
    data: [],
    total: 0,
    outcomeCounts: {},
    loaded: false,
    error: false,
    status: null,
    updatedAt: null,
  });
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(apiUrl(path), {
        headers: adminKey ? { "X-Admin-Key": adminKey } : undefined,
      })
        .then((r) => {
          if (!r.ok) throw new Error(String(r.status));
          return r.json();
        })
        .then((d) => {
          if (!alive) return;
          const items = Array.isArray(d) ? d : Array.isArray(d?.items) ? d.items : [];
          setState({
            data: items,
            total: typeof d?.total === "number" ? d.total : items.length,
            outcomeCounts:
              d?.outcome_counts && typeof d.outcome_counts === "object"
                ? d.outcome_counts
                : {},
            loaded: true,
            error: false,
            status: 200,
            updatedAt: new Date(),
          });
        })
        .catch((err: Error) => {
          if (alive) {
            const parsedStatus = Number.parseInt(err.message, 10);
            setState((s) => ({
              ...s,
              loaded: true,
              error: true,
              status: Number.isFinite(parsedStatus) ? parsedStatus : null,
            }));
          }
        });
    load();
    const timer = setInterval(load, refreshMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [path, refreshMs, adminKey]);
  return state;
}

function useHealth(refreshMs = 10000): boolean | null {
  const [online, setOnline] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(apiUrl("/health"))
        .then((r) => {
          if (alive) setOnline(r.ok);
        })
        .catch(() => {
          if (alive) setOnline(false);
        });
    load();
    const timer = setInterval(load, refreshMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [refreshMs]);
  return online;
}

function useConfig(): PublicConfig | null {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(apiUrl("/v1/config/public"))
      .then((r) => r.json())
      .then((d) => {
        if (alive) setConfig(d);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return config;
}

function fmt(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function duration(start: string | null, end: string | null): string {
  if (!start || !end) return "—";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms <= 0) return "—";
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

function OutcomeBadge({ outcome }: { outcome: string }) {
  const styles: Record<string, string> = {
    booked: "bg-[#ecfdf5] border-[#a7f3d0] text-[#059669]",
    info_only: "bg-[#fffbeb] border-[#fde68a] text-[#b45309]",
    in_progress: "bg-[#eff6ff] border-[#bfdbfe] text-[#1d4ed8]",
  };
  return (
    <span
      className={cn(
        "inline-block rounded-full px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider border font-medium",
        styles[outcome] ?? "bg-[#fafafa] border-[#e7e7e7] text-[#4e505b]"
      )}
    >
      {outcome.replace("_", " ")}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    booked: "bg-[#ecfdf5] border-[#a7f3d0] text-[#059669]",
    completed: "bg-[#eff6ff] border-[#bfdbfe] text-[#1d4ed8]",
    cancelled: "bg-[#fff1f2] border-[#fecdd3] text-[#e11d48]",
  };
  return (
    <span
      className={cn(
        "inline-block rounded-full px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider border font-medium",
        styles[status] ?? "bg-[#fafafa] border-[#e7e7e7] text-[#4e505b]"
      )}
    >
      {status}
    </span>
  );
}

function PlatformBadge({
  platform,
  engine,
}: {
  platform?: string | null;
  engine?: string | null;
}) {
  const isMobile = platform?.toLowerCase() === "mobile";
  const Icon = isMobile ? Smartphone : Monitor;
  const platformLabel = isMobile ? "Mobile" : "Desktop";
  const rawEngine = engine?.toLowerCase();
  const engineLabel =
    rawEngine === "chromium"
      ? "Chrome"
      : rawEngine === "webkit"
      ? "Safari"
      : rawEngine === "gecko"
      ? "Firefox"
      : engine
      ? engine.charAt(0).toUpperCase() + engine.slice(1)
      : null;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-medium border",
        isMobile
          ? "bg-[#faf5ff] text-[#7e22ce] border-[#f3e8ff]"
          : "bg-[#f8fafc] text-[#334155] border-[#e2e8f0]"
      )}
    >
      <Icon className="w-3 h-3 shrink-0 text-current" aria-hidden="true" />
      <span>{platformLabel}</span>
      {engineLabel && (
        <span className="text-[10px] opacity-75 font-mono">({engineLabel})</span>
      )}
    </span>
  );
}

function InputPathBadge({ inputPath }: { inputPath?: string | null }) {
  const isNative = inputPath === "native_web_speech";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-mono uppercase tracking-wider font-semibold border",
        isNative
          ? "bg-[#ecfdf5] text-[#047857] border-[#a7f3d0]"
          : "bg-[#fff7ed] text-[#c2410c] border-[#ffedd5]"
      )}
    >
      {isNative ? "Web Speech" : "Whisper Fallback"}
    </span>
  );
}

function StatCard({
  value,
  label,
  subtext,
}: {
  value: number | string;
  label: string;
  subtext?: string;
}) {
  return (
    <div className="rounded-xl border border-[#e7e7e7] bg-white p-3.5 sm:p-4 min-w-[120px] flex-1 shadow-xs transition-shadow duration-150 hover:shadow-sm">
      <div className="flex items-center justify-between">
        <span className="text-[10px] sm:text-[11px] font-mono uppercase tracking-wider text-[#71717a]">
          {label}
        </span>
        {subtext && (
          <span className="text-[10px] font-mono tabular-nums text-[#059669] bg-[#ecfdf5] border border-[#a7f3d0] px-1.5 py-0.2 rounded-full flex items-center gap-0.5">
            <TrendingUp className="w-2.5 h-2.5" aria-hidden="true" />
            {subtext}
          </span>
        )}
      </div>
      <div className="text-[22px] sm:text-[26px] font-semibold text-[#0a0a0a] tracking-tight leading-none mt-2 font-mono tabular-nums">
        {value}
      </div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-[#e7e7e7] bg-white overflow-hidden shadow-xs">
      <h2 className="text-[12px] font-semibold text-[#0a0a0a] px-3.5 sm:px-4 py-2.5 border-b border-[#e7e7e7] bg-[#fafafa]">
        {title}
      </h2>
      <div className="overflow-x-auto w-full">{children}</div>
    </div>
  );
}

function SkeletonRows({ cols }: { cols: number }) {
  return (
    <>
      {[0, 1, 2].map((i) => (
        <tr key={i} className="border-t border-[#e7e7e7]">
          {Array.from({ length: cols }).map((_, j) => (
            <td key={j} className="px-4 py-2.5">
              <div className="h-3 w-3/4 rounded bg-[#f4f4f5] animate-pulse" />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

/**
 * Calls Table (Desktop View)
 */
function CallsTable({ calls, loading }: { calls: CallRecord[]; loading?: boolean }) {
  const [expanded, setExpanded] = useState<number | null>(null);
  if (loading) {
    return (
      <table className="w-full min-w-[640px] text-left">
        <tbody><SkeletonRows cols={5} /></tbody>
      </table>
    );
  }
  if (calls.length === 0) return <Empty text="No call records yet." />;

  return (
    <table className="w-full min-w-[640px] text-left">
      <thead>
        <tr className="text-[11px] font-semibold uppercase tracking-wider text-[#71717a] bg-[#fafafa] border-b border-[#e7e7e7]">
          <th className="px-4 py-2">Timestamp</th>
          <th className="px-4 py-2">Outcome</th>
          <th className="px-4 py-2">Platform / Input</th>
          <th className="px-4 py-2">Caller Phone</th>
          <th className="px-4 py-2">Transcript Summary</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-[#e7e7e7]">
        {calls.map((c) => (
          <CallRow
            key={c.id}
            call={c}
            expanded={expanded === c.id}
            onToggle={() => setExpanded(expanded === c.id ? null : c.id)}
          />
        ))}
      </tbody>
    </table>
  );
}

function CallRow({
  call,
  expanded,
  onToggle,
}: {
  call: CallRecord;
  expanded: boolean;
  onToggle: () => void;
}) {
  const metrics = call.client_metrics || call.client_telemetry;
  const echoSuppressions = metrics?.echo_suppressions ?? 0;
  const sttErrors = metrics?.stt_errors ?? 0;
  const ttsErrors = metrics?.tts_errors ?? 0;
  const firstAudioMs = metrics?.first_assistant_audio_ms;
  const firstTranscriptMs = metrics?.first_caller_transcript_ms;
  const endReason = call.end_reason || metrics?.end_reason || null;
  const micPermission = call.mic_permission || metrics?.mic_permission || null;

  return (
    <>
      <tr
        onClick={onToggle}
        className="cursor-pointer hover:bg-[#fafafa] transition-colors duration-150 text-[12px]"
      >
        <td className="px-4 py-2.5 whitespace-nowrap text-[#0a0a0a] font-mono tabular-nums text-[11px]">
          {fmt(call.started_at)}
        </td>
        <td className="px-4 py-2.5">
          <OutcomeBadge outcome={call.outcome} />
        </td>
        <td className="px-4 py-2.5 whitespace-nowrap">
          <div className="flex flex-wrap items-center gap-1.5">
            <PlatformBadge platform={call.platform_class} engine={call.browser_engine} />
            <InputPathBadge inputPath={call.input_path} />
          </div>
        </td>
        <td className="px-4 py-2.5 whitespace-nowrap font-mono tabular-nums text-[11px] text-[#4e505b]">
          {call.caller_phone ? (
            <a
              href={cleanTelHref(call.caller_phone)}
              onClick={(e) => e.stopPropagation()}
              className="text-[#0b5ed7] hover:underline"
            >
              {call.caller_phone}
            </a>
          ) : (
            "—"
          )}
        </td>
        <td className="px-4 py-2.5 text-[#4e505b] max-w-[280px]">
          <span className="flex items-center justify-between gap-1">
            <span className="truncate">{call.transcript_summary ?? "—"}</span>
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 shrink-0 transition-transform duration-150 text-[#71717a]",
                expanded && "rotate-180"
              )}
              aria-hidden="true"
            />
          </span>
        </td>
      </tr>
      {expanded && (
        <tr className="bg-[#fafafa] text-[12px]">
          <td colSpan={5} className="px-4 py-3 space-y-3">
            <div className="text-[12px] text-[#0a0a0a] whitespace-pre-wrap break-words leading-relaxed text-pretty">
              {call.transcript_summary ?? "No summary recorded for this call."}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-mono tabular-nums text-[#71717a]">
              <span>Room: {call.room_name}</span>
              <span>Duration: {duration(call.started_at, call.ended_at)}</span>
              {call.ended_at && <span>Ended: {fmt(call.ended_at)}</span>}
            </div>

            {/* Telemetry Metrics Drawer */}
            <div className="rounded-lg border border-[#e2e8f0] bg-white p-3 space-y-2.5 shadow-xs">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#f1f5f9] pb-2">
                <div className="flex items-center gap-1.5 text-[11px] font-semibold text-[#1e293b]">
                  <Activity className="w-3.5 h-3.5 text-[#0b5ed7]" aria-hidden="true" />
                  <span>Client Telemetry & Diagnostics</span>
                </div>
                {endReason && (
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded-md bg-[#f8fafc] border border-[#e2e8f0] text-[#475569]">
                    End Reason: <strong className="text-[#0f172a]">{endReason}</strong>
                  </span>
                )}
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px] font-mono">
                <div className="p-2 rounded-md bg-[#f8fafc] border border-[#e2e8f0]">
                  <div className="text-[9px] uppercase tracking-wider text-[#64748b]">Echo Suppressions</div>
                  <div className="text-[13px] font-semibold text-[#0f172a] mt-0.5 tabular-nums">
                    {echoSuppressions}
                  </div>
                </div>

                <div className="p-2 rounded-md bg-[#f8fafc] border border-[#e2e8f0]">
                  <div className="text-[9px] uppercase tracking-wider text-[#64748b]">STT / TTS Errors</div>
                  <div className="text-[13px] font-semibold text-[#0f172a] mt-0.5 tabular-nums">
                    {sttErrors} / {ttsErrors}
                  </div>
                </div>

                <div className="p-2 rounded-md bg-[#f8fafc] border border-[#e2e8f0]">
                  <div className="text-[9px] uppercase tracking-wider text-[#64748b]">1st Audio Latency</div>
                  <div className="text-[13px] font-semibold text-[#0f172a] mt-0.5 tabular-nums">
                    {firstAudioMs != null ? `${Math.round(firstAudioMs)}ms` : "—"}
                  </div>
                </div>

                <div className="p-2 rounded-md bg-[#f8fafc] border border-[#e2e8f0]">
                  <div className="text-[9px] uppercase tracking-wider text-[#64748b]">1st Transcript Latency</div>
                  <div className="text-[13px] font-semibold text-[#0f172a] mt-0.5 tabular-nums">
                    {firstTranscriptMs != null ? `${Math.round(firstTranscriptMs)}ms` : "—"}
                  </div>
                </div>
              </div>

              {micPermission && (
                <div className="flex items-center gap-1.5 text-[10px] text-[#64748b]">
                  <Mic className="w-3 h-3 text-[#64748b]" aria-hidden="true" />
                  <span>Microphone Permission:</span>
                  <span className="font-semibold uppercase tracking-wider text-[#334155]">{micPermission}</span>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * Mobile Call Cards Feed (Handheld Phone View)
 */
function MobileCallsList({ calls }: { calls: CallRecord[] }) {
  const [expandedId, setExpandedId] = useState<number | null>(null);

  if (calls.length === 0) return <Empty text="No call records yet." />;

  return (
    <div className="space-y-2.5">
      {calls.map((call) => {
        const isExpanded = expandedId === call.id;
        const metrics = call.client_metrics || call.client_telemetry;
        const echoSuppressions = metrics?.echo_suppressions ?? 0;
        const sttErrors = metrics?.stt_errors ?? 0;
        const ttsErrors = metrics?.tts_errors ?? 0;
        const firstAudioMs = metrics?.first_assistant_audio_ms;
        const firstTranscriptMs = metrics?.first_caller_transcript_ms;
        const endReason = call.end_reason || metrics?.end_reason || null;
        const micPermission = call.mic_permission || metrics?.mic_permission || null;

        return (
          <div
            key={call.id}
            className="rounded-xl border border-[#e7e7e7] bg-white p-3.5 space-y-2.5 shadow-xs"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <OutcomeBadge outcome={call.outcome} />
                <span className="text-[10px] font-mono tabular-nums text-[#71717a]">
                  {fmt(call.started_at)}
                </span>
              </div>
              <span className="text-[10px] font-mono tabular-nums text-[#71717a]">
                {duration(call.started_at, call.ended_at)}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <PlatformBadge platform={call.platform_class} engine={call.browser_engine} />
              <InputPathBadge inputPath={call.input_path} />
            </div>

            <div className="flex items-center justify-between gap-2 pt-1 border-t border-[#f4f4f5]">
              <div className="font-mono tabular-nums text-[12px] font-medium text-[#0a0a0a]">
                {call.caller_phone ? (
                  <span className="flex items-center gap-1">
                    <Phone className="w-3 h-3 text-[#71717a]" aria-hidden="true" />
                    {call.caller_phone}
                  </span>
                ) : (
                  <span className="text-[#71717a]">Anonymous Caller</span>
                )}
              </div>

              {call.caller_phone && (
                <a
                  href={cleanTelHref(call.caller_phone)}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium bg-[#eff6ff] text-[#0b5ed7] border border-[#bfdbfe]"
                >
                  <Phone className="w-3 h-3" aria-hidden="true" />
                  <span>Call Back</span>
                </a>
              )}
            </div>

            {call.transcript_summary && (
              <div>
                <button
                  type="button"
                  onClick={() => setExpandedId(isExpanded ? null : call.id)}
                  className="flex items-center justify-between w-full text-[11px] text-[#71717a] hover:text-[#0a0a0a] pt-1"
                >
                  <span className="truncate max-w-[240px] text-left">
                    {call.transcript_summary}
                  </span>
                  <ChevronDown
                    className={cn(
                      "w-3.5 h-3.5 shrink-0 transition-transform duration-150",
                      isExpanded && "rotate-180"
                    )}
                    aria-hidden="true"
                  />
                </button>

                <AnimatePresence>
                  {isExpanded && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      className="overflow-hidden"
                    >
                      <div className="mt-2 p-2.5 rounded-lg bg-[#fafafa] border border-[#e7e7e7] text-[11px] text-[#4e505b] leading-relaxed text-pretty space-y-2">
                        <div>{call.transcript_summary}</div>
                        <div className="pt-2 border-t border-[#e7e7e7] font-mono tabular-nums text-[10px] text-[#71717a]">
                          Room: {call.room_name}
                        </div>

                        {/* Mobile Telemetry Details */}
                        <div className="pt-2 border-t border-[#e7e7e7] space-y-1.5">
                          <div className="flex items-center justify-between text-[10px] font-semibold text-[#1e293b]">
                            <span className="flex items-center gap-1">
                              <Activity className="w-3 h-3 text-[#0b5ed7]" aria-hidden="true" />
                              Telemetry Diagnostics
                            </span>
                            {endReason && (
                              <span className="font-mono text-[#64748b]">
                                End: {endReason}
                              </span>
                            )}
                          </div>
                          <div className="grid grid-cols-2 gap-1.5 text-[10px] font-mono">
                            <div className="p-1.5 rounded bg-white border border-[#e7e7e7]">
                              <span className="text-[#64748b] block text-[9px]">Echo Suppressed:</span>
                              <span className="font-semibold text-[#0f172a]">{echoSuppressions}</span>
                            </div>
                            <div className="p-1.5 rounded bg-white border border-[#e7e7e7]">
                              <span className="text-[#64748b] block text-[9px]">STT/TTS Errors:</span>
                              <span className="font-semibold text-[#0f172a]">{sttErrors} / {ttsErrors}</span>
                            </div>
                            <div className="p-1.5 rounded bg-white border border-[#e7e7e7]">
                              <span className="text-[#64748b] block text-[9px]">1st Audio:</span>
                              <span className="font-semibold text-[#0f172a]">
                                {firstAudioMs != null ? `${Math.round(firstAudioMs)}ms` : "—"}
                              </span>
                            </div>
                            <div className="p-1.5 rounded bg-white border border-[#e7e7e7]">
                              <span className="text-[#64748b] block text-[9px]">1st Transcript:</span>
                              <span className="font-semibold text-[#0f172a]">
                                {firstTranscriptMs != null ? `${Math.round(firstTranscriptMs)}ms` : "—"}
                              </span>
                            </div>
                          </div>
                          {micPermission && (
                            <div className="text-[10px] text-[#64748b] flex items-center gap-1">
                              <Mic className="w-2.5 h-2.5" aria-hidden="true" />
                              <span>Mic: {micPermission}</span>
                            </div>
                          )}
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Appointments Table (Desktop View)
 */
function AppointmentsTable({
  appointments,
  loading,
}: {
  appointments: Appointment[];
  loading?: boolean;
}) {
  if (loading) {
    return (
      <table className="w-full min-w-[540px] text-left">
        <tbody><SkeletonRows cols={4} /></tbody>
      </table>
    );
  }
  if (appointments.length === 0)
    return <Empty text="No appointments scheduled yet." />;

  return (
    <table className="w-full min-w-[540px] text-left">
      <thead>
        <tr className="text-[11px] font-semibold uppercase tracking-wider text-[#71717a] bg-[#fafafa] border-b border-[#e7e7e7]">
          <th className="px-4 py-2">Scheduled For</th>
          <th className="px-4 py-2">Service</th>
          <th className="px-4 py-2">Status</th>
          <th className="px-4 py-2">Customer</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-[#e7e7e7]">
        {appointments.map((a) => (
          <tr
            key={a.id}
            className="hover:bg-[#fafafa] transition-colors duration-150 text-[12px]"
          >
            <td className="px-4 py-2.5 whitespace-nowrap text-[#0a0a0a] font-mono tabular-nums text-[11px]">
              {fmt(a.scheduled_for)}
            </td>
            <td className="px-4 py-2.5 text-[#0a0a0a]">
              <div className="font-medium">{a.service}</div>
              {a.notes && (
                <div className="text-[11px] text-[#71717a] truncate max-w-[220px]">
                  {a.notes}
                </div>
              )}
            </td>
            <td className="px-4 py-2.5">
              <StatusBadge status={a.status} />
            </td>
            <td className="px-4 py-2.5">
              <div className="text-[#0a0a0a] font-medium">{a.customer_name ?? "—"}</div>
              <div className="text-[11px] font-mono tabular-nums text-[#71717a]">
                <a
                  href={cleanTelHref(a.customer_phone)}
                  className="text-[#0b5ed7] hover:underline"
                >
                  {a.customer_phone}
                </a>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="px-4 py-8 text-center text-[12px] text-[#71717a]">
      {text}
    </div>
  );
}

function Spinner() {
  return (
    <div className="flex justify-center py-8">
      <div className="h-5 w-5 animate-spin rounded-full border-2 border-[#e7e7e7] border-t-[#0b5ed7]" />
    </div>
  );
}

/**
 * Settings Page
 */
function SettingsPage({ config }: { config: PublicConfig | null }) {
  if (!config) return <Spinner />;

  return (
    <div className="space-y-5 max-w-4xl pb-8">
      <div className="space-y-0.5">
        <h2 className="text-[14px] font-semibold text-[#0a0a0a]">
          Business Operations &amp; Safety Parameters
        </h2>
        <p className="text-[12px] text-[#71717a]">
          Runtime parameters consumed by the agent worker and appointment scheduler.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Company Profile Card */}
        <div className="rounded-xl border border-[#e7e7e7] bg-white overflow-hidden shadow-xs">
          <div className="px-4 py-2.5 border-b border-[#e7e7e7] bg-[#fafafa] text-[12px] font-semibold text-[#0a0a0a]">
            Company Profile &amp; Contact
          </div>
          <dl className="divide-y divide-[#f4f4f5] text-[12px]">
            <div className="px-4 py-2.5 flex justify-between gap-3">
              <dt className="text-[#71717a]">Company Name</dt>
              <dd className="font-medium text-[#0a0a0a]">{config.company_name || "—"}</dd>
            </div>
            <div className="px-4 py-2.5 flex justify-between items-center gap-3">
              <dt className="text-[#71717a]">Primary Phone</dt>
              <dd className="font-mono text-[#0a0a0a]">
                {config.phone ? (
                  <a href={cleanTelHref(config.phone)} className="text-[#0b5ed7] hover:underline">
                    {config.phone}
                  </a>
                ) : (
                  "—"
                )}
              </dd>
            </div>
            <div className="px-4 py-2.5 flex justify-between items-center gap-3 bg-[#fff1f2]/40">
              <dt className="text-[#e11d48] font-medium flex items-center gap-1">
                <ShieldAlert className="w-3.5 h-3.5" /> Emergency Hotline
              </dt>
              <dd className="font-mono text-[#e11d48] font-semibold">
                {config.emergency_phone ? (
                  <a
                    href={cleanTelHref(config.emergency_phone)}
                    className="underline hover:opacity-80 flex items-center gap-1"
                  >
                    {config.emergency_phone}
                  </a>
                ) : (
                  "—"
                )}
              </dd>
            </div>
            <div className="px-4 py-2.5 flex flex-col sm:flex-row sm:justify-between gap-1 sm:gap-3">
              <dt className="text-[#71717a]">Service Address</dt>
              <dd className="sm:text-right text-[#0a0a0a]">{config.address || "—"}</dd>
            </div>
            <div className="px-4 py-2.5 flex justify-between gap-3">
              <dt className="text-[#71717a]">Timezone</dt>
              <dd className="font-mono text-[#0a0a0a]">{config.timezone || "—"}</dd>
            </div>
          </dl>
        </div>

        {/* Operating Hours Card */}
        <div className="rounded-xl border border-[#e7e7e7] bg-white overflow-hidden shadow-xs">
          <div className="px-4 py-2.5 border-b border-[#e7e7e7] bg-[#fafafa] text-[12px] font-semibold text-[#0a0a0a]">
            Weekly Operating Schedule
          </div>
          <div className="divide-y divide-[#f4f4f5] text-[12px]">
            {config.opening_hours &&
              Object.entries(config.opening_hours).map(([day, hours]) => (
                <div key={day} className="px-4 py-2 flex items-center justify-between">
                  <span className="capitalize font-medium text-[#4e505b]">{day}</span>
                  <span
                    className={cn(
                      "font-mono text-[11px]",
                      String(hours).toLowerCase() === "closed"
                        ? "text-[#a1a1aa] italic"
                        : "text-[#0a0a0a] font-semibold"
                    )}
                  >
                    {String(hours).toLowerCase() === "closed" ? "Closed" : String(hours)}
                  </span>
                </div>
              ))}
          </div>
        </div>
      </div>

      {/* Services Catalog */}
      <div className="rounded-xl border border-[#e7e7e7] bg-white p-4 space-y-3 shadow-xs">
        <div className="text-[12px] font-semibold text-[#0a0a0a]">
          Approved HVAC Services
        </div>
        <div className="flex flex-wrap gap-2">
          {config.services && config.services.length > 0 ? (
            config.services.map((svc) => (
              <span
                key={svc}
                className="px-3 py-1 text-[11px] font-mono rounded-lg border border-[#e7e7e7] bg-[#fafafa] text-[#0a0a0a]"
              >
                {svc}
              </span>
            ))
          ) : (
            <span className="text-[12px] text-[#71717a]">No services configured.</span>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Calls Page
 */
type CallFilter = "all" | "booked" | "info_only" | "in_progress";

function CallsPage({ calls }: { calls: ApiState<CallRecord> }) {
  const [filter, setFilter] = useState<CallFilter>("all");

  const filtered = calls.data.filter((c) => {
    if (filter === "all") return true;
    return c.outcome === filter;
  });
  const countFor = (outcome: CallFilter) =>
    outcome === "all" ? calls.total : calls.outcomeCounts[outcome] ?? 0;

  return (
    <div className="space-y-4 pb-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-0.5">
          <h2 className="text-[14px] font-semibold text-[#0a0a0a]">
            Inbound Call Records
          </h2>
          <p className="text-[12px] text-[#71717a]">
            Full transcript summaries, outcomes, and durations recorded in SQLite.
          </p>
        </div>

        <div className="flex items-center gap-1 p-0.5 rounded-lg border border-[#e7e7e7] bg-[#fafafa]">
          {(["all", "booked", "info_only", "in_progress"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setFilter(t)}
              className={cn(
                "px-2.5 py-1 text-[11px] font-medium rounded-md capitalize transition-colors duration-150 cursor-pointer",
                filter === t
                  ? "bg-white text-[#0a0a0a] border border-[#e7e7e7] font-semibold shadow-xs"
                  : "text-[#71717a] hover:text-[#0a0a0a]"
              )}
            >
              {t === "in_progress" ? "In Progress" : t.replace("_", " ")} ({countFor(t)})
            </button>
          ))}
        </div>
      </div>

      {/* Desktop Table View */}
      <div className="hidden md:block">
          <Card title={`Calls Log (${filtered.length} shown of ${countFor(filter)})`}>
          <CallsTable calls={filtered} loading={!calls.loaded} />
        </Card>
      </div>

      {/* Mobile Card Feed */}
      <div className="md:hidden">
        <MobileCallsList calls={filtered} />
      </div>
    </div>
  );
}

/**
 * Appointments Page
 */
function AppointmentsPage({ appointments }: { appointments: ApiState<Appointment> }) {
  const [viewMode, setViewMode] = useState<"agenda" | "calendar" | "table">("agenda");

  const calendarData: CalendarData[] = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const a of appointments.data) {
      if (!a.scheduled_for) continue;
      const d = new Date(a.scheduled_for);
      if (isNaN(d.getTime())) continue;
      const key = format(d, "yyyy-MM-dd");
      const ev: CalendarEvent = {
        id: a.id,
        name: `${a.service}${a.customer_name ? ` · ${a.customer_name}` : ""}`,
        time: format(d, "h:mm a"),
        datetime: a.scheduled_for,
        customerName: a.customer_name,
        customerPhone: a.customer_phone,
        status: a.status,
        notes: a.notes,
      };
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(ev);
    }
    return Array.from(map.entries()).map(([key, events]) => ({
      day: parse(key, "yyyy-MM-dd", new Date()),
      events,
    }));
  }, [appointments.data]);

  return (
    <div className="space-y-4 pb-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-0.5">
          <h2 className="text-[14px] font-semibold text-[#0a0a0a]">
            Scheduled Appointments
          </h2>
          <p className="text-[12px] text-[#71717a]">
            Upcoming technician dispatches booked through the voice receptionist engine.
          </p>
        </div>

        {/* View Switcher Tabs (Visible on Desktop) */}
        <div className="hidden md:flex items-center gap-1 p-0.5 rounded-lg border border-[#e7e7e7] bg-[#fafafa]">
          <button
            type="button"
            onClick={() => setViewMode("calendar")}
            className={cn(
              "inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors duration-150 cursor-pointer",
              viewMode === "calendar"
                ? "bg-white text-[#0a0a0a] border border-[#e7e7e7] font-semibold shadow-xs"
                : "text-[#71717a] hover:text-[#0a0a0a]"
            )}
          >
            <CalendarDays className="w-3.5 h-3.5" />
            <span>Calendar View</span>
          </button>
          <button
            type="button"
            onClick={() => setViewMode("table")}
            className={cn(
              "inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors duration-150 cursor-pointer",
              viewMode === "table"
                ? "bg-white text-[#0a0a0a] border border-[#e7e7e7] font-semibold shadow-xs"
                : "text-[#71717a] hover:text-[#0a0a0a]"
            )}
          >
            <TableIcon className="w-3.5 h-3.5" />
            <span>Table View ({appointments.data.length})</span>
          </button>
        </div>
      </div>

      {/* Desktop Calendar or Table */}
      <div className="hidden md:block">
        {viewMode === "calendar" ? (
          <FullScreenCalendar data={calendarData} />
        ) : (
          <Card title={`All Scheduled Appointments (${appointments.data.length})`}>
            <AppointmentsTable
              appointments={appointments.data}
              loading={!appointments.loaded}
            />
          </Card>
        )}
      </div>

      {/* Dedicated Mobile Agenda Component for Phones */}
      <div className="md:hidden">
        <MobileAgendaView
          appointments={appointments.data}
          loading={!appointments.loaded}
        />
      </div>
    </div>
  );
}

/**
 * Dashboard Page
 */
function DashboardPage({
  calls,
  appointments,
  loading,
  onNavigate,
}: {
  calls: ApiState<CallRecord>;
  appointments: ApiState<Appointment>;
  loading: boolean;
  onNavigate: (page: Page) => void;
}) {
  const bookedCount = calls.outcomeCounts.booked ?? calls.data.filter((c) => c.outcome === "booked").length;
  const rate = calls.total > 0 ? Math.round((bookedCount / calls.total) * 100) : 0;

  return (
    <div className="space-y-5 pb-8">
      <Reveal>
        <section className="rounded-xl border border-[#e7e7e7] bg-white px-4 py-4 sm:px-5 sm:py-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div className="max-w-2xl space-y-1.5">
              <p className="app-kicker text-[10px] font-mono font-semibold uppercase tracking-[0.16em]">
                Reception desk / today
              </p>
              <h2 className="text-[18px] font-semibold tracking-tight text-[#0a0a0a]">
                A calm view of every customer conversation.
              </h2>
              <p className="app-lead text-[12px] leading-relaxed">
                Review call outcomes, confirm bookings, or run the voice reception flow exactly as a customer would.
              </p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate("live-call")}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#0b5ed7] px-3.5 py-2 text-[12px] font-semibold text-white transition-colors cursor-pointer"
            >
              <PhoneCall className="h-3.5 w-3.5" aria-hidden="true" />
              Run a voice demo
            </button>
          </div>
        </section>
      </Reveal>

      {/* Metrics Row */}
      <Reveal delay={0.04} className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-3">
        <StatCard
          value={loading ? "—" : calls.total}
          label="Calls handled"
          subtext="Inbound"
        />
        <StatCard
          value={loading ? "—" : bookedCount}
          label="Bookings confirmed"
          subtext="Confirmed"
        />
        <StatCard
          value={loading ? "—" : appointments.data.length}
          label="Upcoming visits"
        />
        <StatCard
          value={loading ? "—" : `${rate}%`}
          label="Booking rate"
          subtext="Conversion"
        />
      </Reveal>

      {/* Mobile Quick Action Card */}
      <div className="md:hidden rounded-2xl border border-[#bfdbfe] bg-[#eff6ff] p-4 flex items-center justify-between gap-3 shadow-2xs">
        <div className="space-y-0.5">
          <div className="flex items-center gap-1.5 text-[12px] font-semibold text-[#0b5ed7]">
            <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Voice reception</span>
          </div>
          <p className="text-[11px] text-[#4e505b]">
            Run the customer-facing voice flow from your phone.
          </p>
        </div>
        <motion.button
          whileTap={{ scale: 0.94 }}
          onClick={() => onNavigate("live-call")}
          aria-label="Start live call"
          className="inline-flex items-center gap-1 px-3.5 py-2 rounded-xl text-[12px] font-semibold text-white bg-[#0b5ed7] shadow-xs cursor-pointer shrink-0"
        >
          <PhoneCall className="w-3.5 h-3.5" aria-hidden="true" />
          <span>Call</span>
        </motion.button>
      </div>

      {/* Two-Column Grid */}
      <Reveal delay={0.08} className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        {/* Recent Calls */}
        <div className="space-y-2">
          <div className="flex items-center justify-between px-1">
            <span className="text-[12px] font-semibold text-[#0a0a0a]">
              Conversation activity
            </span>
            <button
              onClick={() => onNavigate("calls")}
              className="text-[11px] font-medium text-[#0b5ed7] hover:underline cursor-pointer flex items-center gap-0.5"
            >
              <span>View all calls</span>
              <ArrowUpRight className="w-3 h-3" aria-hidden="true" />
            </button>
          </div>

          <div className="hidden md:block">
            <Card title="Recent Calls">
              <CallsTable calls={calls.data.slice(0, 6)} loading={loading} />
            </Card>
          </div>
          <div className="md:hidden">
            <MobileCallsList calls={calls.data.slice(0, 4)} />
          </div>
        </div>

        {/* Upcoming Appointments */}
        <div className="space-y-2">
          <div className="flex items-center justify-between px-1">
            <span className="text-[12px] font-semibold text-[#0a0a0a]">
              Confirmed schedule
            </span>
            <button
              onClick={() => onNavigate("appointments")}
              className="text-[11px] font-medium text-[#0b5ed7] hover:underline cursor-pointer flex items-center gap-0.5"
            >
              <span>View schedule</span>
              <ArrowUpRight className="w-3 h-3" aria-hidden="true" />
            </button>
          </div>

          <div className="hidden md:block">
            <Card title="Confirmed Schedule">
              <AppointmentsTable
                appointments={appointments.data.slice(0, 6)}
                loading={loading}
              />
            </Card>
          </div>
          <div className="md:hidden">
            <MobileAgendaView
              appointments={appointments.data}
              loading={loading}
            />
          </div>
        </div>
      </Reveal>
    </div>
  );
}

export default function App() {
  const [adminKey, setAdminKey] = useState<string | null>(() =>
    typeof window === "undefined" ? null : window.sessionStorage.getItem("hvac-admin-key")
  );
  const calls = useApi<CallRecord>("/v1/calls?limit=200", 10000, adminKey);
  const appointments = useApi<Appointment>("/v1/appointments", 10000, adminKey);
  const online = useHealth();
  const config = useConfig();
  const [page, setPage] = useState<Page>("dashboard");
  const [open, setOpen] = useState(false);
  const [isInCall, setIsInCall] = useState(false);

  const updatedAt =
    calls.updatedAt && appointments.updatedAt
      ? calls.updatedAt > appointments.updatedAt
        ? calls.updatedAt
        : appointments.updatedAt
      : calls.updatedAt ?? appointments.updatedAt;
  const loading = !calls.loaded || !appointments.loaded;
  const apiError = calls.error || appointments.error;
  const adminAccessNeeded = calls.status === 401 || appointments.status === 401;

  const updateAdminKey = () => {
    const promptMessage = adminKey
      ? "Enter a new dashboard access key, or leave blank and click OK to lock/clear:"
      : "Enter the private dashboard access key:";
    const entered = window.prompt(promptMessage);
    if (entered === null) return;
    const trimmed = entered.trim();
    if (!trimmed) {
      window.sessionStorage.removeItem("hvac-admin-key");
      setAdminKey(null);
    } else {
      window.sessionStorage.setItem("hvac-admin-key", trimmed);
      setAdminKey(trimmed);
    }
  };

  const links: {
    page: Page;
    label: string;
    href: string;
    icon: React.ReactNode;
  }[] = [
    {
      page: "dashboard",
      label: "Dashboard",
      href: "#dashboard",
      icon: <LayoutDashboard className="h-4 w-4 flex-shrink-0" />,
    },
    {
      page: "live-call",
      label: "Live Call",
      href: "#live-call",
      icon: <Radio className="h-4 w-4 flex-shrink-0 text-[#0b5ed7]" />,
    },
    {
      page: "calls",
      label: "Calls",
      href: "#calls",
      icon: <PhoneCall className="h-4 w-4 flex-shrink-0" />,
    },
    {
      page: "appointments",
      label: "Appointments",
      href: "#appointments",
      icon: <CalendarCheck className="h-4 w-4 flex-shrink-0" />,
    },
    {
      page: "settings",
      label: "Settings",
      href: "#settings",
      icon: <Settings className="h-4 w-4 flex-shrink-0" />,
    },
  ];

  return (
    <div className="app-shell relative flex flex-col md:flex-row h-screen w-full overflow-hidden">
      {/* Desktop Collapsible Sidebar (Hidden on mobile < md) */}
      <Sidebar open={open} setOpen={setOpen}>
        <SidebarBody className="app-sidebar justify-between gap-6 border-r border-[#e7e7e7]">
          <div className="flex flex-col flex-1 overflow-y-auto overflow-x-hidden">
            <Logo
              showText={open}
              onNavigate={() => {
                setPage("dashboard");
                setOpen(false);
              }}
              companyName={config?.company_name}
            />
            <div className="mt-6 flex flex-col gap-1">
              {links.map((link) => (
                <SidebarLink
                  key={link.page}
                  link={{
                    label: link.label,
                    href: link.href,
                    icon: (
                      <span
                        className={cn(
                          "flex-shrink-0",
                          page === link.page ? "text-[#0b5ed7]" : "text-[#71717a]"
                        )}
                      >
                        {link.icon}
                      </span>
                    ),
                    onClick: () => {
                      setPage(link.page);
                      setOpen(false);
                    },
                  }}
                  className={cn(
                    "rounded-lg px-2.5 py-1.5 text-[12px] font-medium transition-colors duration-150",
                    page === link.page
                      ? "bg-[#f4f4f5] text-[#0a0a0a] border border-[#e7e7e7] font-semibold"
                      : "text-[#4e505b] hover:bg-[#fafafa] hover:text-[#0a0a0a]"
                  )}
                />
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2 px-2 py-3 text-[11px] font-mono text-[#71717a] border-t border-[#e7e7e7]">
            <PhoneIncoming className="h-4 w-4 flex-shrink-0" />
            <motion.span
              animate={{
                display: open ? "inline-block" : "none",
                opacity: open ? 1 : 0,
              }}
              className="whitespace-pre"
            >
              Demo workspace
            </motion.span>
          </div>
        </SidebarBody>
      </Sidebar>

      {/* Mobile Top App Bar (Sticky Header on screens < md) */}
      <div className="app-sidebar md:hidden sticky top-0 inset-x-0 z-40 backdrop-blur-md border-b border-[#e7e7e7] px-4 py-2.5 pt-safe flex items-center justify-between">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="h-7 w-7 rounded-lg bg-[#0b5ed7] text-white flex items-center justify-center font-bold text-[11px] shrink-0 shadow-2xs tracking-tight">
            {getInitials(config?.company_name)}
          </div>
          <div className="min-w-0">
            <div className="text-[13px] font-semibold tracking-tight text-[#0a0a0a] leading-tight truncate max-w-[210px]">
              {config?.company_name ?? "HVAC Receptionist"}
            </div>
            <div className="flex items-center gap-1.5 text-[10px] font-mono text-[#71717a]">
              <span
                className={cn(
                  "w-1.5 h-1.5 rounded-full",
                  online === true ? "bg-emerald-500 animate-pulse" : "bg-rose-500"
                )}
                aria-hidden="true"
              />
              <span>{online === true ? "Online" : "Connecting…"}</span>
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={updateAdminKey}
          className="md:hidden rounded-full border border-[#e7e7e7] bg-white px-2.5 py-1 text-[10px] font-semibold text-[#4e505b]"
        >
          {adminKey ? "Records" : "Unlock"}
        </button>

        {/* Quick Emergency Call Button */}
        {config?.emergency_phone && (
          <a
            href={cleanTelHref(config.emergency_phone)}
            className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-[#fff1f2] border border-[#fecdd3] text-[#e11d48] text-[11px] font-semibold shadow-2xs active:scale-95 transition-transform"
            aria-label="Call Emergency Hotline"
          >
            <ShieldAlert className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Emergency</span>
          </a>
        )}
      </div>

      {/* Main Content Area */}
      <main className="flex-1 min-h-0 min-w-0 overflow-y-auto">
        <div className="p-3.5 sm:p-5 md:p-7 min-h-full border-l-0 md:border-l border-[#e7e7e7] pb-24 md:pb-8">
          {/* Desktop Top Header Bar */}
          <header className="app-header hidden md:flex mb-6 pb-4 border-b border-[#e7e7e7] flex-wrap items-center justify-between gap-3">
            <div>
              <p className="app-kicker mb-1 text-[10px] font-mono font-semibold uppercase tracking-[0.16em]">Operations console</p>
              <h1 className="text-[18px] font-semibold tracking-tight text-[#0a0a0a] capitalize text-balance">
                {page === "live-call" ? "Voice demo" : page}
              </h1>
              <p className="text-[12px] text-[#71717a]">
                {config?.company_name ?? "HVAC Receptionist"}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={updateAdminKey}
                className="rounded-lg border border-[#e7e7e7] bg-white px-3 py-1.5 text-[11px] font-semibold text-[#4e505b] hover:bg-[#fafafa]"
              >
                {adminKey ? "Admin access set" : "Unlock records"}
              </button>
              <div className="flex items-center gap-2 text-[11px] text-[#71717a] px-3 py-1 rounded-lg border border-[#e7e7e7] bg-[#fafafa]">
                <span
                  className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    online === null && "bg-[#a1a1aa]",
                    online === true && "bg-emerald-500 animate-pulse",
                    online === false && "bg-rose-500"
                  )}
                  aria-hidden="true"
                />
                <span>
                  {online === null
                    ? "connecting…"
                    : online
                    ? "API online"
                    : "API offline"}
                </span>
                {updatedAt && (
                  <span className="text-[#a1a1aa] font-mono tabular-nums">
                    · updated {updatedAt.toLocaleTimeString()}
                  </span>
                )}
              </div>
            </div>
          </header>

          {apiError && (
            <div className="mb-4 rounded-xl border border-[#fde68a] bg-[#fffbeb] px-4 py-2.5 text-[12px] text-[#b45309] shadow-xs">
              {adminAccessNeeded
                ? "Customer records are private. Select “Unlock records” and enter the server-configured access key."
                : "Connecting to backend API… If the server was idle, it takes ~30–50s to wake up. Retrying automatically."}
            </div>
          )}

          {page === "dashboard" && (
            <DashboardPage
              calls={calls}
              appointments={appointments}
              loading={loading}
              onNavigate={(p) => setPage(p)}
            />
          )}
          {page === "live-call" && (
            <LiveCallPage
              companyName={config?.company_name}
              onNavigateToCalls={() => setPage("calls")}
              onCallStateChange={(inCall) => setIsInCall(inCall)}
            />
          )}
          {page === "calls" && <CallsPage calls={calls} />}
          {page === "appointments" && <AppointmentsPage appointments={appointments} />}
          {page === "settings" && <SettingsPage config={config} />}
        </div>
      </main>

      {/* Dedicated Mobile Bottom Navigation Bar (Screens < md) - Hidden during active call for full screen immersion */}
      {!isInCall && (
        <MobileBottomNav
          currentPage={page}
          onNavigate={(newPage) => setPage(newPage)}
          callCount={calls.data.length}
          appointmentCount={appointments.data.length}
          isInCall={isInCall}
        />
      )}
    </div>
  );
}

function getInitials(name?: string | null): string {
  if (!name || name === "HVAC Receptionist") return "HR";
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

function Logo({
  showText,
  onNavigate,
  companyName,
}: {
  showText: boolean;
  onNavigate: () => void;
  companyName?: string;
}) {
  const displayName = companyName || "HVAC Receptionist";
  const initials = getInitials(companyName);
  return (
    <a
      href="#dashboard"
      onClick={(e) => {
        e.preventDefault();
        onNavigate();
      }}
      aria-label={`${displayName} Dashboard`}
      className="flex items-center gap-2.5 py-1 px-1 relative z-20 text-[13px] font-semibold text-[#0a0a0a] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0b5ed7] rounded-md transition-colors"
    >
      <div className="h-6 w-6 rounded-md bg-[#0b5ed7] text-white flex items-center justify-center font-bold text-[10px] shrink-0 shadow-2xs tracking-tight">
        {initials}
      </div>
      <motion.span
        initial={{ opacity: 0 }}
        animate={{ opacity: showText ? 1 : 0 }}
        className="font-semibold tracking-tight text-[#0a0a0a] whitespace-pre truncate max-w-[170px]"
      >
        {displayName}
      </motion.span>
    </a>
  );
}
